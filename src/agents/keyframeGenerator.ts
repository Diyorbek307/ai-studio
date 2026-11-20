import fs from "node:fs";
import { assertBudget, recordCost } from "../budget.js";
import { log } from "../log.js";
import { generateImage } from "../providers/image.js";
import { episodeFile, saveEpisode } from "../store.js";
import type { Episode } from "../types.js";
import { agentInfo } from "./index.js";

const AGENT = agentInfo(35);

/** Рисует ключевой кадр для каждой сцены. Уже нарисованные кадры не перерисовывает. */
export async function drawKeyframes(ep: Episode): Promise<void> {
  if (!ep.script || !ep.shots) throw new Error("Нет сценария или промптов кадров");
  ep.keyframes ??= {};

  for (const [i, shot] of ep.shots.entries()) {
    const rel = `keyframes/${shot.scene_id}.png`;
    if (ep.keyframes[shot.scene_id] === rel && fs.existsSync(episodeFile(ep, rel))) continue;

    assertBudget();
    const scene = ep.script.scenes.find((s) => s.id === shot.scene_id);
    const label = `${ep.script.title}\n\n${shot.scene_id}: ${scene?.lines.map((l) => l.text).join(" ") ?? ""}`;
    log.agent(AGENT, `кадр ${i + 1}/${ep.shots.length} (${shot.scene_id})`);

    const result = await generateImage(shot.image_prompt, episodeFile(ep, rel), label, i);
    recordCost({ agent: AGENT, kind: "image", usd: result.costUsd, detail: shot.scene_id, episodeId: ep.id });
    ep.costUsd += result.costUsd;
    ep.keyframes[shot.scene_id] = rel;
    saveEpisode(ep);
  }
}
