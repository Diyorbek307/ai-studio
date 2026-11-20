import { askStructured, isMockLlm } from "../llm.js";
import { log } from "../log.js";
import { saveSeries } from "../store.js";
import { DesignSchema, type Series } from "../types.js";
import { seriesContext } from "./context.js";
import { agentInfo } from "./index.js";

const AGENT = agentInfo(21);

const SYSTEM = `Ты — Дизайнер персонажей (агент №21) в AI-студии мультсериала.

Напиши канон внешности на английском, по которому художник-нейросеть каждый раз рисует героев одинаково:
- style_prompt — стиль всего сериала: техника рисовки, свет, палитра, настроение, 25–45 слов;
- для каждого героя visual_prompt — 35–60 слов: форма тела, цвета, фактура, лицо и глаза, одежда и аксессуары, отличительная деталь.
Описывай только то, что видно. Без имён реальных людей, студий, брендов и логотипов.
id героев бери из библии без изменений.`;

/** Нужен ли дизайн: нет канона стиля или у кого-то из героев нет канона внешности. */
export function needsDesign(series: Series): boolean {
  return !series.style_prompt || series.characters.some((c) => !c.visual_prompt);
}

export async function designSeries(series: Series, opts: { force?: boolean } = {}): Promise<Series> {
  if (!opts.force && !needsDesign(series)) return series;
  log.agent(AGENT, `пишу канон внешности для «${series.title}»`);

  const design = await askStructured({
    agent: AGENT,
    system: SYSTEM,
    context: seriesContext(series),
    prompt: "Напиши канон стиля и внешности всех героев.",
    schema: DesignSchema,
    effort: "high",
    mock: () => ({
      style_prompt:
        "stylized 3D animated family cartoon, soft global illumination, warm vibrant colors, expressive big eyes, clean shapes, cheerful bazaar atmosphere",
      characters: series.characters.map((c) => ({ id: c.id, visual_prompt: c.look })),
    }),
  });

  const updated: Series = {
    ...series,
    style_prompt: design.style_prompt,
    characters: series.characters.map((c) => ({
      ...c,
      visual_prompt: design.characters.find((d) => d.id === c.id)?.visual_prompt ?? c.visual_prompt ?? c.look,
    })),
  };
  if (isMockLlm()) {
    // Заглушки в библию не пишем: иначе настоящий Claude потом решит, что канон уже готов.
    log.agent(AGENT, "демо-режим: канон используется только в этой серии, в файл не сохраняется");
    return updated;
  }
  saveSeries(updated);
  log.agent(AGENT, `канон сохранён в series/${series.slug}.json`);
  return updated;
}
