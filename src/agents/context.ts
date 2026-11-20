import type { Series } from "../types.js";

/**
 * Библия сериала одним текстом. Она одинаковая для всех агентов и всех серий,
 * поэтому идёт отдельным блоком system и кэшируется у Claude.
 */
export function seriesContext(series: Series): string {
  const characters = series.characters
    .map((c) =>
      [
        `- id: ${c.id} | ${c.name} — ${c.role}`,
        `  характер: ${c.personality}`,
        `  внешность: ${c.look}`,
        c.visual_prompt ? `  канон внешности (EN): ${c.visual_prompt}` : "",
        c.catchphrases.length ? `  коронные фразы: ${c.catchphrases.join(" / ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
  const locations = series.locations.map((l) => `- id: ${l.id} | ${l.name}: ${l.description}`).join("\n");

  return [
    `# Библия сериала «${series.title}»`,
    `Язык серий: ${series.language}. Длина серии: около ${series.target_duration_sec} секунд, вертикальное видео 9:16.`,
    `Логлайн: ${series.logline}`,
    `Тон: ${series.tone}`,
    `Аудитория: ${series.audience}`,
    `Визуальный стиль: ${series.style_guide}`,
    series.style_prompt ? `Канон стиля (EN): ${series.style_prompt}` : "",
    `## Персонажи\n${characters}`,
    `## Локации\n${locations}`,
    series.rubrics.length ? `## Рубрики\n${series.rubrics.map((r) => `- ${r}`).join("\n")}` : "",
    series.rules.length ? `## Правила, которые нельзя нарушать\n${series.rules.map((r) => `- ${r}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function characterById(series: Series, id: string) {
  return series.characters.find((c) => c.id === id);
}

export function locationById(series: Series, id: string) {
  return series.locations.find((l) => l.id === id);
}
