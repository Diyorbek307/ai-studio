import fs from "node:fs";
import { assertBudget, recordCost } from "../budget.js";
import { errorMessage, log } from "../log.js";
import { ENGINE_LABEL, type EngineChoice, resolveEngine } from "../providers/engines.js";
import { generateImage } from "../providers/image.js";
import { episodeFile, saveEpisode } from "../store.js";
import { config } from "../config.js";
import { characterAsset, cutoutStill, isPlaceholder, locationAsset } from "../media/cutout.js";
import type { ImageReference } from "../providers/gemini.js";
import type { SoulReference } from "../providers/higgsfield.js";
import { refreshSoulStatus } from "./soulTrainer.js";
import { characterById } from "./context.js";
import type { Episode, Scene, Series } from "../types.js";
import { agentInfo } from "./index.js";

const AGENT = agentInfo(35);

/** Нарисованные картинки героев и места сцены (не заглушки) — образцы для Gemini и Grok. */
export function sceneReferences(series: Series, scene: Scene): ImageReference[] {
  const refs: ImageReference[] = [];
  for (const id of scene.characters) {
    const c = characterById(series, id);
    const file = characterAsset(series.slug, id);
    if (c && fs.existsSync(file) && !isPlaceholder(file)) {
      refs.push({ label: c.name, kind: "character", base64: fs.readFileSync(file).toString("base64"), mimeType: "image/png" });
    }
  }
  const loc = series.locations.find((l) => l.id === scene.location);
  const bg = loc ? locationAsset(series.slug, loc.id) : undefined;
  if (loc && bg && fs.existsSync(bg) && !isPlaceholder(bg)) {
    refs.push({ label: loc.name, kind: "location", base64: fs.readFileSync(bg).toString("base64"), mimeType: "image/png" });
  }
  return refs;
}

/**
 * Обученный в Higgsfield герой сцены (SOUL держит одного героя на кадр — берём первого в сцене).
 * Если обучение ещё шло, спрашиваем статус у Higgsfield и сохраняем его в библию сериала.
 */
async function sceneSoul(series: Series, scene: Scene): Promise<SoulReference | undefined> {
  for (const id of scene.characters) {
    const c = characterById(series, id);
    const ref = c?.higgsfield_ref;
    if (!c || !ref) continue;
    if (ref.status !== "completed" && ref.status !== "failed") {
      try {
        const fresh = await refreshSoulStatus(series.slug, id);
        if (fresh?.status === "completed") return { id: fresh.id };
      } catch (error) {
        log.warn(`Soul ID ${c.name}: ${errorMessage(error)}`);
      }
      continue;
    }
    if (ref.status === "completed") return { id: ref.id };
  }
  return undefined;
}

/** Рисует ключевой кадр для каждой сцены. Уже нарисованные кадры не перерисовывает. */
export async function drawKeyframes(ep: Episode, series: Series): Promise<void> {
  if (!ep.script || !ep.shots) throw new Error("Нет сценария или промптов кадров");
  ep.keyframes ??= {};
  const engine = resolveEngine(ep.engineChoice as EngineChoice | undefined, "image");
  ep.engines = { ...ep.engines, image: engine };
  log.agent(AGENT, `рисую движком ${ENGINE_LABEL[engine]}`);

  for (const [i, shot] of ep.shots.entries()) {
    const rel = `keyframes/${shot.scene_id}.png`;
    if (ep.keyframes[shot.scene_id] === rel && fs.existsSync(episodeFile(ep, rel))) continue;

    assertBudget();
    const scene = ep.script.scenes.find((s) => s.id === shot.scene_id);
    const label = `${ep.script.title}\n\n${shot.scene_id}: ${scene?.lines.map((l) => l.text).join(" ") ?? ""}`;
    log.agent(AGENT, `кадр ${i + 1}/${ep.shots.length} (${shot.scene_id})`);

    // Перекладка не рисует новую картинку: кадр собирается из фона и героев сериала, бесплатно.
    const result =
      engine === "cutout" && scene
        ? (await cutoutStill(series, scene, episodeFile(ep, rel)), { costUsd: 0 })
        : await generateImage({
            prompt: shot.image_prompt,
            out: episodeFile(ep, rel),
            label,
            index: i,
            engine,
            references: scene && config.image.references ? sceneReferences(series, scene) : undefined,
            soul: engine === "higgsfield" && scene ? await sceneSoul(series, scene) : undefined,
          });
    recordCost({ agent: AGENT, kind: "image", usd: result.costUsd, detail: shot.scene_id, episodeId: ep.id });
    ep.costUsd += result.costUsd;
    ep.keyframes[shot.scene_id] = rel;
    saveEpisode(ep);
  }
}
