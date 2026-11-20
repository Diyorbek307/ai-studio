import { askStructured } from "../llm.js";
import { log } from "../log.js";
import { type Idea, IdeaBatchSchema, type Insights, type Series } from "../types.js";
import { seriesContext } from "./context.js";
import { agentInfo } from "./index.js";

const AGENT = agentInfo(7);

const SYSTEM = `Ты — Генератор идей (агент №7) в AI-студии, которая каждый день выпускает короткие серии мультсериала для Instagram Reels.

Задача: предложить 5 разных сюжетов для следующей серии и выбрать лучший.

Требования к идее:
- сюжет укладывается в 20–40 секунд и 3–5 коротких сцен;
- есть понятная завязка в первые 2 секунды и смешная развязка или клиффхэнгер в конце;
- опирается на рубрики сериала и характеры героев;
- не повторяет недавние серии;
- соблюдает правила сериала;
- в поле characters — id героев из библии (2–3 героя), в поле location — id локации из библии.

score — твоя честная оценка от 1 до 10, насколько серию досмотрят и перешлют.
Пиши поля по-русски.`;

export async function generateIdea(opts: {
  series: Series;
  recentTitles: string[];
  insights?: Insights;
  brief?: string;
  episodeId: string;
}): Promise<{ idea: Idea; alternatives: Idea[] }> {
  const { series, recentTitles, insights, brief } = opts;
  log.agent(AGENT, brief ? `придумываю 5 сюжетов по заданию: «${brief}»` : "придумываю 5 сюжетов");

  const prompt = [
    brief
      ? `ЗАДАНИЕ ПРОДЮСЕРА — все 5 идей должны его выполнить, это важнее рубрик и аналитики:\n${brief}`
      : "",
    recentTitles.length
      ? `Недавние серии (не повторяй):\n${recentTitles.map((t) => `- ${t}`).join("\n")}`
      : "Это одна из первых серий: познакомь зрителя с героями.",
    insights
      ? `Что говорит аналитика:\n- заходит: ${insights.what_works.join("; ")}\n- избегать: ${insights.what_to_avoid.join("; ")}\n- подсказки: ${insights.next_ideas_hints.join("; ")}`
      : "Статистики пока нет.",
    "Предложи 5 идей и выбери лучшую.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const batch = await askStructured({
    agent: AGENT,
    system: SYSTEM,
    context: seriesContext(series),
    prompt,
    schema: IdeaBatchSchema,
    effort: "high",
    episodeId: opts.episodeId,
    mock: () => mockIdeas(series, recentTitles.length, brief),
  });

  if (batch.ideas.length === 0) throw new Error("Генератор идей не вернул ни одной идеи");
  const index = Math.min(Math.max(0, Math.round(batch.chosen_index)), batch.ideas.length - 1);
  const idea = batch.ideas[index]!;
  log.agent(AGENT, `выбрал: «${idea.title}» — ${batch.reason}`);
  return { idea, alternatives: batch.ideas.filter((_, i) => i !== index) };
}

function mockIdeas(series: Series, seed: number, brief?: string) {
  const ids = series.characters.map((c) => c.id);
  const location = series.locations[0]?.id ?? "stall";
  const pick = (i: number) => ids[i % ids.length]!;
  const topics = brief ? [brief] : series.rubrics.length ? series.rubrics : ["Серия о героях"];
  const ideas: Idea[] = topics.map((rubric, i) => ({
    title: brief ? brief.slice(0, 60) : `${rubric.split(":")[0]} #${seed + 1}`,
    logline: `${rubric}. Демо-сюжет без Claude.`,
    characters: [pick(seed + i), pick(seed + i + 1)],
    location: series.locations[i % series.locations.length]?.id ?? location,
    hook_idea: "Герой выбегает в кадр с неожиданной новостью",
    why_it_works: "Узнаваемая бытовая ситуация",
    score: 7,
  }));
  return { ideas, chosen_index: seed % ideas.length, reason: "демо-режим" };
}
