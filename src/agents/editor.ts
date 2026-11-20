import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { log } from "../log.js";
import { ffmpeg } from "../media/ffmpeg.js";
import { episodeDir, episodeFile } from "../store.js";
import { END_CARD_SECONDS, endCardFor, renderEndCard } from "../media/endCard.js";
import type { Episode, Series } from "../types.js";
import { agentInfo } from "./index.js";

const AGENT = agentInfo(61);
const MUSIC_EXT = [".mp3", ".m4a", ".wav", ".ogg"];

/** Фоновая музыка из папки music/: выбирается по id эпизода, чтобы серии звучали по-разному. */
export function pickMusic(episodeId: string, dir = config.musicDir): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  const files = fs
    .readdirSync(dir)
    .filter((f) => MUSIC_EXT.includes(path.extname(f).toLowerCase()))
    .sort();
  if (files.length === 0) return undefined;
  const hash = [...episodeId].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  return path.join(dir, files[hash % files.length]!);
}

/**
 * Склейка: каждый клип подгоняется под длину своей сцены, клипы идут подряд,
 * реплики ложатся на свои места, музыка тихо играет под ними.
 */
export async function editEpisode(ep: Episode, series?: Series): Promise<string> {
  if (!ep.voice || !ep.clips) throw new Error("Нет клипов или озвучки");
  const { width: W, height: H, fps } = config.render;
  const dir = episodeDir(ep.id);
  const work = path.join(dir, "edit");
  fs.mkdirSync(work, { recursive: true });

  // 1. Сегменты одинакового формата: вертикаль, 30 к/с, ровно длина сцены (короткий клип зацикливается).
  const segments: string[] = [];
  for (const span of ep.voice.scenes) {
    const clip = ep.clips[span.sceneId];
    if (!clip) throw new Error(`Нет клипа для сцены ${span.sceneId}`);
    const seg = path.join(work, `seg-${span.sceneId}.mp4`);
    await ffmpeg([
      "-stream_loop",
      "-1",
      "-i",
      episodeFile(ep, clip),
      "-t",
      (span.end - span.start).toFixed(3),
      "-vf",
      `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=yuv420p,setsar=1`,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      seg,
    ]);
    segments.push(seg);
  }

  // Фирменная концовка бренда — последним сегментом, музыка доигрывает под ней.
  const card = series ? endCardFor(series) : undefined;
  if (card && series) {
    const seg = path.join(work, "seg-endcard.mp4");
    await renderEndCard(series, card, seg);
    segments.push(seg);
  }

  const list = path.join(work, "segments.txt");
  fs.writeFileSync(list, segments.map((s) => `file '${path.basename(s)}'`).join("\n") + "\n");
  const videoOnly = path.join(work, "video.mp4");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", "segments.txt", "-c", "copy", path.basename(videoOnly)], work);

  // 2. Звуковая дорожка: тишина на всю длину + реплики со сдвигом + музыка.
  const total = ep.voice.total + (card ? END_CARD_SECONDS : 0);
  const inputs: string[] = ["-i", videoOnly];
  const filters: string[] = [`anullsrc=channel_layout=stereo:sample_rate=44100:d=${total.toFixed(3)}[base]`];
  const mixLabels = ["[base]"];
  ep.voice.lines.forEach((line, i) => {
    inputs.push("-i", episodeFile(ep, line.file));
    const ms = Math.round(line.start * 1000);
    filters.push(`[${i + 1}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[v${i}]`);
    mixLabels.push(`[v${i}]`);
  });
  const music = pickMusic(ep.id);
  if (music) {
    inputs.push("-stream_loop", "-1", "-i", music);
    const idx = ep.voice.lines.length + 1;
    const fadeStart = Math.max(0, total - 1.5);
    filters.push(
      `[${idx}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${config.render.musicVolume},atrim=0:${total.toFixed(3)},afade=t=out:st=${fadeStart.toFixed(3)}:d=1.5[bg]`,
    );
    mixLabels.push("[bg]");
  }
  filters.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:normalize=0:duration=first[aout]`);

  const out = "edited.mp4";
  await ffmpeg([
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "0:v",
    "-map",
    "[aout]",
    "-t",
    total.toFixed(3),
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    path.join(dir, out),
  ]);

  log.agent(AGENT, `смонтировано ${segments.length - (card ? 1 : 0)} сцен${card ? " + фирменная концовка" : ""}${music ? `, музыка: ${path.basename(music)}` : ", без музыки"}`);
  return out;
}
