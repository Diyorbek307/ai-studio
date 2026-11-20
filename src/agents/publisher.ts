import { config } from "../config.js";
import { clientForBrand, instagramFor, telegramChannelFor } from "../clients.js";
import { publishReel } from "../integrations/instagram.js";
import { sendVideo, telegramEnabled } from "../integrations/telegram.js";
import { errorMessage, log } from "../log.js";
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

/**
 * Публикация одобренной серии: в Telegram-канал бренда (если он подключён) и в Instagram бренда.
 * Результат пишется в ep.publish сразу по ходу: если Instagram упадёт, пост в канале не повторится при новой попытке.
 */
export async function publishEpisode(ep: Episode): Promise<NonNullable<Episode["publish"]>> {
  if (!ep.final) throw new Error("Нет готового ролика");
  const prev = ep.publish;
  const publish: NonNullable<Episode["publish"]> = { at: new Date().toISOString() };
  ep.publish = publish;

  const channel = telegramChannelFor(ep.series);
  if (channel && telegramEnabled()) {
    if (prev?.telegram?.messageId && prev.telegram.chat === channel) {
      publish.telegram = prev.telegram;
    } else {
      try {
        const messageId = await sendVideo(channel, episodeFile(ep, ep.final), postCaption(ep));
        publish.telegram = { chat: channel, messageId };
        log.agent(AGENT, `опубликовано в Telegram-канале ${channel}`);
      } catch (error) {
        publish.telegram = { chat: channel, error: errorMessage(error) };
        log.warn(`Telegram-канал ${channel}: ${errorMessage(error)}`);
      }
    }
  }

  const account = instagramFor(ep.series);
  if (!account) {
    const whose = clientForBrand(ep.series) ? "Instagram клиента не подключён" : "Instagram не подключён";
    publish.dryRun = true;
    publish.note = publish.telegram?.messageId
      ? `Опубликовано в Telegram-канале. ${whose} — в Instagram выложите вручную.`
      : `${whose} — ролик готов к ручной публикации: ${episodeFile(ep, ep.final)}`;
    log.agent(AGENT, publish.note);
    return publish;
  }
  if (prev?.mediaId) return { ...publish, mediaId: prev.mediaId, permalink: prev.permalink };
  if (!config.server.publicBaseUrl) {
    throw new Error("Для публикации нужен PUBLIC_BASE_URL: Instagram скачивает ролик по публичной ссылке на сервер студии");
  }

  const videoUrl = `${config.server.publicBaseUrl}/media/${ep.id}/${ep.final}`;
  log.agent(AGENT, "загружаю ролик в Instagram");
  const result = await publishReel(account, videoUrl, postCaption(ep));
  log.agent(AGENT, `опубликовано: ${result.permalink ?? result.mediaId}`);
  publish.mediaId = result.mediaId;
  publish.permalink = result.permalink;
  return publish;
}
