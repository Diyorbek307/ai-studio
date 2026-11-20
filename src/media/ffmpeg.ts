import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

function exec(cmd: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) =>
      reject(new Error(`Не удалось запустить ${cmd}: ${err.message}. Установлен ли ffmpeg?`)),
    );
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} завершился с кодом ${code}:\n${stderr.split("\n").slice(-12).join("\n")}`));
    });
  });
}

export async function ffmpeg(args: string[], cwd?: string): Promise<void> {
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], cwd);
}

export interface ProbeResult {
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
  sizeMb: number;
}

export async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await exec("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type,width,height",
    "-of",
    "json",
    file,
  ]);
  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number }[];
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    duration: Number(data.format?.duration ?? 0),
    hasAudio: data.streams?.some((s) => s.codec_type === "audio") ?? false,
    sizeMb: fs.statSync(file).size / (1024 * 1024),
  };
}

/** Формат пикселей первой картинки/видео (rgba, rgb24, yuvj420p…) — по нему видно, есть ли прозрачность. */
export async function pixelFormat(file: string): Promise<string> {
  const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", file]);
  return stdout.trim();
}

/**
 * Громкость звука по окнам step секунд (RMS, дБ). Тишина — -120.
 * По ней перекладка открывает рот героя: громко — рот открыт, пауза между словами — закрыт.
 */
export async function loudness(file: string, step = 0.08): Promise<number[]> {
  const rate = 16000;
  const { stdout } = await exec("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", file,
    "-af", `aresample=${rate},asetnsamples=n=${Math.round(rate * step)}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
    "-f", "null", "-",
  ]);
  return stdout
    .split("\n")
    .filter((l) => l.startsWith("lavfi.astats.Overall.RMS_level="))
    .map((l) => {
      const v = Number(l.split("=")[1]);
      return Number.isFinite(v) ? Math.max(-120, v) : -120;
    });
}

/**
 * Когда открыт рот: окна громче порога, через одно — чтобы рот «шлёпал», а не застывал открытым.
 * Порог считается от самого громкого окна реплики: тихий и громкий голос двигают рот одинаково.
 * Возвращает отрезки [начало, конец] в секундах от начала файла.
 */
export function mouthOpenRanges(levels: number[], step = 0.08): [number, number][] {
  const peak = Math.max(-120, ...levels);
  if (peak < -60) return []; // тишина: голоса нет
  const threshold = Math.max(peak - 18, -50);
  const out: [number, number][] = [];
  levels.forEach((db, i) => {
    if (db < threshold || i % 2 === 1) return;
    const s = i * step;
    const last = out.at(-1);
    if (last && Math.abs(last[1] - s) < 1e-6) last[1] = s + step;
    else out.push([s, s + step]);
  });
  return out;
}

export async function mediaDuration(file: string): Promise<number> {
  return (await probe(file)).duration;
}

const { width: W, height: H, fps: FPS } = config.render;

/** Экранирование текста для фильтра drawtext. */
function drawtextEscape(text: string): string {
  return text.replace(/\\/g, "\\\\\\\\").replace(/'/g, "\u2019").replace(/:/g, "\\:").replace(/%/g, "\\%");
}

/** Цветная карточка 1080×1920 с подписью — кадр демо-режима. */
export async function placeholderImage(label: string, colorHex: string, out: string): Promise<void> {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const color = `0x${colorHex.replace("#", "")}`;
  const wrapped = wrapText(label, 30).slice(0, 8).join("\n");
  const textFile = `${out}.txt`;
  fs.writeFileSync(textFile, wrapped);
  try {
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=${W}x${H}`,
      "-vf",
      `drawtext=textfile='${drawtextEscape(textFile)}':fontcolor=white:fontsize=54:line_spacing=18:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.35:boxborderw=40`,
      "-frames:v",
      "1",
      out,
    ]);
  } catch {
    // Сборка ffmpeg без drawtext/шрифтов: просто цветной кадр.
    await ffmpeg(["-f", "lavfi", "-i", `color=c=${color}:s=${W}x${H}`, "-frames:v", "1", out]);
  } finally {
    fs.rmSync(textFile, { force: true });
  }
}

/** Приводит любую картинку к вертикали 1080×1920 (заполнение с обрезкой). */
export async function normalizeImage(input: string, out: string): Promise<void> {
  await ffmpeg([
    "-i",
    input,
    "-vf",
    `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`,
    "-frames:v",
    "1",
    out,
  ]);
}

/** Медленный наезд камеры по статичному кадру — видео демо-режима. */
export async function kenBurns(image: string, seconds: number, out: string): Promise<void> {
  const bigW = Math.round(W * 1.1);
  const bigH = Math.round(H * 1.1);
  const dx = bigW - W;
  const dy = bigH - H;
  await ffmpeg([
    "-loop",
    "1",
    "-i",
    image,
    "-t",
    seconds.toFixed(2),
    "-vf",
    `scale=${bigW}:${bigH},crop=${W}:${H}:x='${dx}*t/${seconds.toFixed(2)}':y='${dy}*t/${seconds.toFixed(2)}',fps=${FPS},format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-an",
    out,
  ]);
}

/** Тишина заданной длины — голос демо-режима. */
export async function silence(seconds: number, out: string): Promise<void> {
  await ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", seconds.toFixed(2), out]);
}

/** Кадры из видео в указанные секунды, уменьшенные вдвое — для проверки качества. */
export async function extractFrames(video: string, times: number[], outDir: string): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  for (const [i, t] of times.entries()) {
    const out = path.join(outDir, `frame-${i + 1}.jpg`);
    await ffmpeg(["-ss", t.toFixed(2), "-i", video, "-frames:v", "1", "-vf", `scale=${W / 2}:${H / 2}`, "-q:v", "4", out]);
    files.push(out);
  }
  return files;
}

export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && (line + " " + word).length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
