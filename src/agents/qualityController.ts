import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { askStructured } from "../llm.js";
import { log } from "../log.js";
import { extractFrames, probe } from "../media/ffmpeg.js";
import { episodeDir, episodeFile } from "../store.js";
import { type Episode, type QaReport, QaReviewSchema, type Series, type TechCheck } from "../types.js";
import { seriesContext } from "./context.js";
import { agentInfo } from "./index.js";

const AGENT = agentInfo(71);

const SYSTEM = `Ты — Контролёр качества (агент №71) в AI-студии мультсериала для Instagram Reels.
Тебе показывают 4 кадра из готового ролика и его сценарий. Найди то, из-за чего ролик стыдно выпускать:
- visual: искажённые лица и руки, лишние конечности, мусорный текст или буквы в кадре, герой не похож на свой канон, кадр не соответствует сцене;
- subtitles: субтитры не читаются, обрезаны, налезают на лица;
- script: реплики нарушают правила сериала, грубые ошибки в узбекском, нет смысла или шутки;
- other: всё остальное, что заметит зритель.
severity "blocker" — только то, что нельзя выпускать; мелочи — "minor".
pass = false, если есть хотя бы один blocker.
redo_from — с какого шага переделывать: script (проблема в тексте), shots (картинка), voice (звук), edit (монтаж), none.
summary_ru — 1–2 предложения для продюсера по-русски.`;

export function techProblems(t: Omit<TechCheck, "problems">): string[] {
  const { width, height } = config.render;
  const problems: string[] = [];
  if (t.width !== width || t.height !== height) problems.push(`размер ${t.width}×${t.height}, нужен ${width}×${height}`);
  if (t.duration < 5) problems.push(`слишком короткий: ${t.duration.toFixed(1)} с`);
  if (t.duration > 90) problems.push(`слишком длинный для Reels: ${t.duration.toFixed(1)} с`);
  if (!t.hasAudio) problems.push("нет звуковой дорожки");
  if (t.sizeMb > 250) problems.push(`файл слишком большой: ${t.sizeMb.toFixed(0)} МБ`);
  return problems;
}

export async function checkQuality(ep: Episode, series: Series): Promise<QaReport> {
  if (!ep.final || !ep.script) throw new Error("Нет готового ролика");
  const file = episodeFile(ep, ep.final);
  const p = await probe(file);
  const tech: TechCheck = { ...p, problems: techProblems(p) };

  const times = [0.15, 0.4, 0.65, 0.9].map((k) => k * p.duration);
  const frames = await extractFrames(file, times, path.join(episodeDir(ep.id), "qa"));

  const review = await askStructured({
    agent: AGENT,
    system: SYSTEM,
    context: seriesContext(series),
    prompt: `Сценарий ролика:\n${JSON.stringify(ep.script, null, 2)}\n\nПеред тобой 4 кадра на 15%, 40%, 65% и 90% длины ролика. Проверь качество.`,
    images: frames.map((f) => ({ mediaType: "image/jpeg" as const, base64: fs.readFileSync(f).toString("base64") })),
    schema: QaReviewSchema,
    effort: "medium",
    episodeId: ep.id,
    mock: () => ({
      pass: true,
      issues: [],
      redo_from: "none" as const,
      summary_ru: "Демо-режим: проверены только размер, длина и звук, кадры без Claude не просматривались.",
    }),
  });

  const blockers = review.issues.filter((i) => i.severity === "blocker").length;
  const pass = tech.problems.length === 0 && review.pass && blockers === 0;
  log.agent(
    AGENT,
    pass ? `проверка пройдена: ${review.summary_ru}` : `есть проблемы: ${[...tech.problems, ...review.issues.map((i) => i.note)].join("; ")}`,
  );
  return { tech, review, pass, checkedAt: new Date().toISOString() };
}
