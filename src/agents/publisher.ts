import { config } from "../config.js";
import { instagramEnabled, publishReel } from "../integrations/instagram.js";
import { log } from "../log.js";
import { episodeFile } from "../store.js";
import type { Episode } from "../types.js";
import { agentInfo } from "./index.js";

const AGENT = agentInfo(81);

/** Пометка для зрителя, что ролик сделан с помощью AI (правило студии № 4). */
export const AI_LABEL = "🤖 Sunʼiy intellekt yordamida yaratildi";

export function postCaption(ep: Episode): string {
  if (!ep.script) return AI_LABEL;
  return [ep.script.caption, ep.script.hashtags.join(" "), AI_LABEL].filter(Boolean).join("\n\n");
}

export async function publishEpisode(ep: Episode): Promise<NonNullable<Episode["publish"]>> {
  if (!ep.final) throw new Error("Нет готового ролика");
  const at = new Date().toISOString();

  if (!instagramEnabled()) {
    const note = `Instagram не подключён — ролик готов к ручной публикации: ${episodeFile(ep, ep.final)}`;
    log.agent(AGENT, note);
    return { at, dryRun: true, note };
  }
  if (!config.server.publicBaseUrl) {
    throw new Error("Для публикации нужен PUBLIC_BASE_URL: Instagram скачивает ролик по публичной ссылке на сервер студии");
  }

  const videoUrl = `${config.server.publicBaseUrl}/media/${ep.id}/${ep.final}`;
  log.agent(AGENT, "загружаю ролик в Instagram");
  const result = await publishReel(videoUrl, postCaption(ep));
  log.agent(AGENT, `опубликовано: ${result.permalink ?? result.mediaId}`);
  return { at, mediaId: result.mediaId, permalink: result.permalink };
}
