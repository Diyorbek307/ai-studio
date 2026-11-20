import fs from "node:fs";
import { assertBudget, recordCost } from "../budget.js";
import { config } from "../config.js";
import { log } from "../log.js";
import { ENGINE_LABEL, type EngineChoice, resolveEngine } from "../providers/engines.js";
import { animateImage } from "../providers/video.js";
import { episodeFile, saveEpisode } from "../store.js";
import type { Episode } from "../types.js";
import { agentInfo } from "./index.js";

const AGENT = agentInfo(42);

/** Оживляет каждый ключевой кадр в клип длиной со сцену. Готовые клипы не переделывает. */
export async function animateScenes(ep: Episode): Promise<void> {
  if (!ep.shots || !ep.keyframes || !ep.voice) throw new Error("Нет кадров или озвучки");
  ep.clips ??= {};
  const engine = resolveEngine(ep.engineChoice as EngineChoice | undefined, "video");
  ep.engines = { ...ep.engines, video: engine };
  log.agent(AGENT, `оживляю движком ${ENGINE_LABEL[engine]}`);

  for (const [i, span] of ep.voice.scenes.entries()) {
    const rel = `clips/${span.sceneId}.mp4`;
    if (ep.clips[span.sceneId] === rel && fs.existsSync(episodeFile(ep, rel))) continue;

    const keyframe = ep.keyframes[span.sceneId];
    const shot = ep.shots.find((s) => s.scene_id === span.sceneId);
    if (!keyframe || !shot) throw new Error(`Нет кадра для сцены ${span.sceneId}`);

    assertBudget();
    log.agent(AGENT, `клип ${i + 1}/${ep.voice.scenes.length} (${span.sceneId})`);
    const result = await animateImage({
      image: episodeFile(ep, keyframe),
      imageUrl: config.server.publicBaseUrl ? `${config.server.publicBaseUrl}/media/${ep.id}/${keyframe}` : undefined,
      motionPrompt: shot.motion_prompt,
      seconds: span.end - span.start,
      out: episodeFile(ep, rel),
      engine,
    });
    recordCost({ agent: AGENT, kind: "video", usd: result.costUsd, detail: span.sceneId, episodeId: ep.id });
    ep.costUsd += result.costUsd;
    ep.clips[span.sceneId] = rel;
    saveEpisode(ep);
  }
}
