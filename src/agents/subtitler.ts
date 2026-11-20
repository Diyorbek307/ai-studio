import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { log } from "../log.js";
import { ffmpeg } from "../media/ffmpeg.js";
import { episodeDir } from "../store.js";
import type { Episode, VoiceTimeline } from "../types.js";
import { agentInfo } from "./index.js";

const AGENT = agentInfo(63);

/** Сколько секунд в начале висит крупный текст-хук. */
export const HOOK_SECONDS = 2.5;

/** 3.456 → 0:00:03.46 (формат времени ASS). */
export function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** 3.456 → 00:00:03,456 (формат времени SRT). */
export function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

/** Фигурные скобки в ASS — команды форматирования, обратная косая — спецсимвол; убираем их из реплик. */
export function assText(text: string): string {
  return text.replace(/[{}]/g, "").replace(/\\/g, "/").replace(/\r?\n/g, "\\N").trim();
}

export function buildAss(timeline: VoiceTimeline, hookText: string | undefined, font: string): string {
  const { width, height } = config.render;
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Реплики — белые внизу; хук — крупный жёлтый вверху. Цвета в формате &HAABBGGRR.
    `Style: Line,${font},62,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,5,2,2,90,90,330,1`,
    `Style: Hook,${font},84,&H0000E5FF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,3,8,80,80,250,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events: string[] = [];
  if (hookText && hookText.trim()) {
    const end = Math.min(HOOK_SECONDS, timeline.total);
    events.push(`Dialogue: 1,${assTime(0)},${assTime(end)},Hook,,0,0,0,,${assText(hookText)}`);
  }
  for (const line of timeline.lines) {
    events.push(`Dialogue: 0,${assTime(line.start)},${assTime(line.end)},Line,${line.character},0,0,0,,${assText(line.text)}`);
  }
  return [...header, ...events].join("\n") + "\n";
}

export function buildSrt(timeline: VoiceTimeline): string {
  return timeline.lines
    .map((line, i) => `${i + 1}\n${srtTime(line.start)} --> ${srtTime(line.end)}\n${line.text}\n`)
    .join("\n");
}

/** Пишет subs.ass и subs.srt, вжигает субтитры в ролик → final.mp4. */
export async function addSubtitles(ep: Episode): Promise<{ final: string; subtitles: string }> {
  if (!ep.voice || !ep.edited) throw new Error("Нет смонтированного ролика");
  const dir = episodeDir(ep.id);
  fs.writeFileSync(path.join(dir, "subs.ass"), buildAss(ep.voice, ep.hook?.on_screen_text, config.render.subtitleFont));
  fs.writeFileSync(path.join(dir, "subs.srt"), buildSrt(ep.voice));

  // Запуск из папки эпизода: относительный путь к .ass не нужно экранировать в фильтре.
  const fontsDir = config.render.subtitleFontsDir ? `:fontsdir='${config.render.subtitleFontsDir.replace(/'/g, "")}'` : "";
  await ffmpeg(
    ["-i", ep.edited, "-vf", `ass=subs.ass${fontsDir}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", "-movflags", "+faststart", "final.mp4"],
    dir,
  );
  log.agent(AGENT, `субтитры: ${ep.voice.lines.length} реплик${ep.hook ? " + хук" : ""}`);
  return { final: "final.mp4", subtitles: "subs.srt" };
}
