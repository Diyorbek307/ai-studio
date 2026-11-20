import { askStructured } from "../llm.js";
import { log } from "../log.js";
import { HookSchema, type Script, type Series } from "../types.js";
import { seriesContext } from "./context.js";
import { agentInfo } from "./index.js";

const AGENT = agentInfo(13);

const SYSTEM = `Ты — Мастер хуков (агент №13) в AI-студии мультсериала для Instagram Reels.

Зритель решает за 2 секунды, листать дальше или смотреть. Твоя задача — первые 2 секунды серии.
Предложи 5 вариантов начала и выбери самый цепляющий. Каждый вариант:
- opening_line — первая реплика первой сцены на узбекском латиницей (до 8 слов), её произносит тот же герой, что и в сценарии;
- opening_line_ru — её перевод на русский;
- on_screen_text — крупный текст поверх кадра на узбекском, до 5 слов, интрига без спойлера;
- visual — что происходит в кадре в первую секунду, на английском.
Не меняй сюжет и героев — только подачу начала.`;

export interface Hook {
  opening_line: string;
  opening_line_ru: string;
  on_screen_text: string;
  visual: string;
}

export async function makeHook(opts: { series: Series; script: Script; episodeId: string }): Promise<Hook> {
  const { series, script } = opts;
  log.agent(AGENT, "ищу самое цепляющее начало");

  const batch = await askStructured({
    agent: AGENT,
    system: SYSTEM,
    context: seriesContext(series),
    prompt: `Сценарий серии:\n${JSON.stringify(script, null, 2)}\n\nПредложи 5 вариантов начала и выбери лучший.`,
    schema: HookSchema,
    effort: "medium",
    episodeId: opts.episodeId,
    mock: () => {
      const first = script.scenes[0]?.lines[0];
      return {
        variants: [
          {
            opening_line: first?.text ?? script.title,
            opening_line_ru: first?.translation_ru ?? script.title,
            on_screen_text: script.title.split(" ").slice(0, 4).join(" "),
            visual: script.scenes[0]?.visual ?? "",
          },
        ],
        chosen_index: 0,
        reason: "демо-режим",
      };
    },
  });

  if (batch.variants.length === 0) throw new Error("Мастер хуков не вернул вариантов");
  const index = Math.min(Math.max(0, Math.round(batch.chosen_index)), batch.variants.length - 1);
  const hook = batch.variants[index]!;
  log.agent(AGENT, `начало: «${hook.on_screen_text}» — ${batch.reason}`);
  return hook;
}

/** Вставляет хук в сценарий: новая первая реплика и новое описание первого кадра. */
export function applyHook(script: Script, hook: Hook): Script {
  const [first, ...rest] = script.scenes;
  if (!first) return script;
  const lines = first.lines.length
    ? [{ ...first.lines[0]!, text: hook.opening_line, translation_ru: hook.opening_line_ru }, ...first.lines.slice(1)]
    : first.lines;
  return {
    ...script,
    scenes: [{ ...first, lines, visual: hook.visual || first.visual }, ...rest],
  };
}
