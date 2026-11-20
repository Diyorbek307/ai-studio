import { askStructured } from "../llm.js";
import { log } from "../log.js";
import { type Script, type Series, type Shot, ShotListSchema } from "../types.js";
import { characterById, locationById, seriesContext } from "./context.js";
import { agentInfo } from "./index.js";

const AGENT = agentInfo(23);

const SYSTEM = `Ты — Хранитель внешности (агент №23) в AI-студии мультсериала.

Для каждой сцены сценария напиши на английском:
- image_prompt — что в кадре: композиция, позы, эмоции, взаимодействие героев, ракурс, детали фона. 30–60 слов.
  НЕ описывай внешность героев (цвета, одежду, форму) — её студия подставит из канона дословно,
  иначе герой будет выглядеть по-разному от кадра к кадру. Называй героев по именам из библии.
  Ничего, что противоречит канону. Без текста, вывесок и логотипов в кадре;
- motion_prompt — как кадр оживает за 5–10 секунд: движения героев, мимика, камера. 15–35 слов.
scene_id бери из сценария без изменений. Одна запись на каждую сцену.`;

/**
 * Финальный промпт кадра: часть сцены от Claude + канон героев и стиля дословно.
 * Канон добавляется кодом, а не моделью, — так он гарантированно одинаковый во всех кадрах.
 */
export function composeImagePrompt(series: Series, script: Script, sceneId: string, scenePart: string): string {
  const scene = script.scenes.find((s) => s.id === sceneId);
  const characters = (scene?.characters ?? [])
    .map((id) => characterById(series, id))
    .filter((c) => c !== undefined)
    .map((c) => `${c.name}: ${c.visual_prompt ?? c.look}`);
  const location = scene ? locationById(series, scene.location) : undefined;
  return [
    scenePart.trim(),
    characters.length ? `Characters — ${characters.join(" | ")}` : "",
    location ? `Setting: ${location.description}` : "",
    `Style: ${series.style_prompt ?? series.style_guide}`,
    "Vertical 9:16 frame, characters large in frame, no text, no letters, no logos, no watermark.",
  ]
    .filter(Boolean)
    .join(". ");
}

export async function buildShots(opts: { series: Series; script: Script; episodeId: string }): Promise<Shot[]> {
  const { series, script } = opts;
  log.agent(AGENT, `готовлю промпты для ${script.scenes.length} кадров`);

  const list = await askStructured({
    agent: AGENT,
    system: SYSTEM,
    context: seriesContext(series),
    prompt: `Сценарий:\n${JSON.stringify(script.scenes, null, 2)}\n\nНапиши image_prompt и motion_prompt для каждой сцены.`,
    schema: ShotListSchema,
    effort: "medium",
    episodeId: opts.episodeId,
    mock: () => ({
      shots: script.scenes.map((s) => ({
        scene_id: s.id,
        image_prompt: `${s.visual}. ${s.camera}`,
        motion_prompt: `${s.camera}; characters talk and gesture expressively`,
      })),
    }),
  });

  // По одному кадру на сцену, в порядке сценария; если модель пропустила сцену — берём описание из сценария.
  return script.scenes.map((scene) => {
    const shot = list.shots.find((s) => s.scene_id === scene.id);
    const scenePart = shot?.image_prompt ?? `${scene.visual}. ${scene.camera}`;
    return {
      scene_id: scene.id,
      image_prompt: composeImagePrompt(series, script, scene.id, scenePart),
      motion_prompt: shot?.motion_prompt ?? scene.camera,
    };
  });
}
