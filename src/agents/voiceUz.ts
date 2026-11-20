import path from "node:path";
import { assertBudget, recordCost } from "../budget.js";
import { log } from "../log.js";
import { mediaDuration } from "../media/ffmpeg.js";
import { speak } from "../providers/tts.js";
import { episodeDir, episodeFile } from "../store.js";
import type { Episode, Series, VoiceLine, VoiceTimeline } from "../types.js";
import { characterById } from "./context.js";
import { agentInfo } from "./index.js";

const AGENT = agentInfo(51);

/** Пауза перед первой репликой сцены, между репликами и после последней (секунды). */
export const LEAD_IN = 0.3;
export const GAP = 0.25;
export const TAIL = 0.6;

/**
 * Раскладка реплик по времени. Сцена длится не меньше, чем задумал сценарист,
 * и не меньше, чем нужно, чтобы произнести все реплики.
 */
export function layoutTimeline(
  scenes: { id: string; duration_sec: number; lines: { character: string; text: string; file: string; seconds: number }[] }[],
): VoiceTimeline {
  const lines: VoiceLine[] = [];
  const sceneSpans: VoiceTimeline["scenes"] = [];
  let t = 0;
  for (const scene of scenes) {
    const start = t;
    let cursor = start + LEAD_IN;
    for (const [index, line] of scene.lines.entries()) {
      lines.push({
        sceneId: scene.id,
        index,
        character: line.character,
        text: line.text,
        file: line.file,
        start: round(cursor),
        end: round(cursor + line.seconds),
      });
      cursor += line.seconds + GAP;
    }
    const spoken = scene.lines.length ? cursor - GAP + TAIL : start;
    const end = round(Math.max(start + scene.duration_sec, spoken));
    sceneSpans.push({ sceneId: scene.id, start: round(start), end });
    t = end;
  }
  return { lines, scenes: sceneSpans, total: round(t) };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function voiceEpisode(ep: Episode, series: Series): Promise<VoiceTimeline> {
  if (!ep.script) throw new Error("Нет сценария");
  const dir = episodeDir(ep.id);
  const scenes = [];
  for (const scene of ep.script.scenes) {
    const lines = [];
    for (const [i, line] of scene.lines.entries()) {
      assertBudget();
      const character = characterById(series, line.character);
      const result = await speak({
        text: line.text,
        language: series.language,
        voice: character?.voice ?? {},
        outBase: episodeFile(ep, `voice/${scene.id}-${i + 1}`),
      });
      recordCost({ agent: AGENT, kind: "tts", usd: result.costUsd, detail: `${scene.id}-${i + 1}`, episodeId: ep.id });
      ep.costUsd += result.costUsd;
      lines.push({
        character: line.character,
        text: line.text,
        file: path.relative(dir, result.file),
        seconds: await mediaDuration(result.file),
      });
    }
    scenes.push({ id: scene.id, duration_sec: scene.duration_sec, lines });
  }
  const timeline = layoutTimeline(scenes);
  log.agent(AGENT, `озвучено ${timeline.lines.length} реплик, ролик ${timeline.total.toFixed(1)} с`);
  return timeline;
}
