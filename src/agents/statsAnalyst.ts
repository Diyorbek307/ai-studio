import { instagramFor } from "../clients.js";
import { mediaInsights } from "../integrations/instagram.js";
import { askStructured } from "../llm.js";
import { errorMessage, log } from "../log.js";
import { listEpisodes, saveEpisode, saveInsights } from "../store.js";
import { type Insights, InsightsSchema, type Series } from "../types.js";
import { seriesContext } from "./context.js";
import { agentInfo } from "./index.js";

const AGENT = agentInfo(91);

const SYSTEM = `Ты — Аналитик статистики (агент №91) в AI-студии мультсериала для Instagram Reels.
Тебе дают опубликованные серии с цифрами: просмотры, охват, лайки, комментарии, репосты, сохранения.
Найди закономерности: какие темы, герои, рубрики и начала собирают больше досмотров, репостов и сохранений, а какие проваливаются.
Пиши по-русски, коротко и по делу, со ссылками на конкретные серии и цифры.
next_ideas_hints — 3–5 конкретных подсказок Генератору идей для следующих серий.`;

/** Обновляет цифры по опубликованным роликам за последние 30 дней. Возвращает, сколько роликов обновлено. */
export async function collectStats(series: string): Promise<number> {
  const account = instagramFor(series);
  if (!account) {
    log.agent(AGENT, "Instagram не подключён — статистику собирать неоткуда");
    return 0;
  }
  const monthAgo = Date.now() - 30 * 24 * 3600 * 1000;
  let updated = 0;
  for (const ep of listEpisodes()) {
    if (ep.series !== series || !ep.publish?.mediaId || Date.parse(ep.publish.at) < monthAgo) continue;
    try {
      const metrics = await mediaInsights(account, ep.publish.mediaId);
      ep.stats = { fetchedAt: new Date().toISOString(), metrics };
      saveEpisode(ep);
      updated++;
    } catch (error) {
      log.warn(`Статистика ${ep.id}: ${errorMessage(error)}`);
    }
  }
  log.agent(AGENT, `обновлена статистика ${updated} роликов`);
  return updated;
}

/** Делает выводы по цифрам и сохраняет их — их читает Генератор идей. */
export async function analyzeStats(series: Series): Promise<Insights | undefined> {
  const withStats = listEpisodes()
    .filter((ep) => ep.series === series.slug && ep.stats && ep.script)
    .slice(0, 20);
  if (withStats.length < 2) {
    log.agent(AGENT, "для выводов нужно хотя бы 2 опубликованных ролика с цифрами");
    return undefined;
  }

  const table = withStats.map((ep) => ({
    title: ep.script!.title,
    idea: ep.idea?.logline,
    hook: ep.hook?.on_screen_text,
    characters: [...new Set(ep.script!.scenes.flatMap((s) => s.characters))],
    published: ep.publish?.at.slice(0, 10),
    metrics: ep.stats!.metrics,
  }));

  const insights = await askStructured({
    agent: AGENT,
    system: SYSTEM,
    context: seriesContext(series),
    prompt: `Опубликованные серии и их цифры:\n${JSON.stringify(table, null, 2)}\n\nСделай выводы.`,
    schema: InsightsSchema,
    effort: "medium",
    mock: () => ({
      summary_ru: `Демо-режим: собраны цифры по ${table.length} роликам, выводы без Claude не делаются.`,
      what_works: [],
      what_to_avoid: [],
      next_ideas_hints: [],
    }),
  });
  saveInsights(series.slug, insights);
  log.agent(AGENT, insights.summary_ru);
  return insights;
}
