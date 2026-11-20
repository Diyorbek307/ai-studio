import { config } from "../config.js";
import { log } from "../log.js";
import { episodeFile } from "../store.js";
import { type InlineKeyboard, sendMessage, sendVideo, telegramEnabled } from "../integrations/telegram.js";
import type { Episode, Series } from "../types.js";
import { characterById } from "./context.js";
import { agentInfo } from "./index.js";

const AGENT = agentInfo(80);

export function approvalKeyboard(episodeId: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "✅ Одобрить", callback_data: `approve:${episodeId}` },
        { text: "🔁 Переделать", callback_data: `redo:${episodeId}` },
      ],
      [{ text: "🗑 Отклонить", callback_data: `reject:${episodeId}` }],
    ],
  };
}

export function videoCaption(ep: Episode): string {
  const qa = ep.qa;
  const qaLine = !qa ? "" : qa.pass ? `✅ Проверка: ${qa.review.summary_ru}` : `⚠️ Есть замечания: ${[...qa.tech.problems, ...qa.review.issues.map((i) => i.note)].join("; ")}`;
  return [
    `🎬 ${ep.script?.title ?? ep.id}`,
    ep.idea?.logline ?? "",
    qaLine,
    `⏱ ${ep.voice?.total.toFixed(0) ?? "?"} с · 💵 $${ep.costUsd.toFixed(2)} · ${ep.id}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function scriptText(ep: Episode, series: Series): string {
  if (!ep.script) return "";
  const scenes = ep.script.scenes
    .map((scene, i) => {
      const lines = scene.lines
        .map((l) => `${characterById(series, l.character)?.name ?? l.character}: ${l.text}\n   ↳ ${l.translation_ru}`)
        .join("\n");
      return `Сцена ${i + 1}\n${lines || "(без реплик)"}`;
    })
    .join("\n\n");
  return [
    `📝 Сценарий «${ep.script.title}»`,
    ep.hook ? `Хук на экране: ${ep.hook.on_screen_text}` : "",
    scenes,
    `Подпись: ${ep.script.caption}\n↳ ${ep.script.caption_ru}`,
    ep.script.hashtags.join(" "),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Отправляет готовый ролик на одобрение: в Telegram, если он настроен, иначе — подсказка в консоли. */
export async function requestApproval(ep: Episode, series: Series): Promise<void> {
  if (!ep.final) throw new Error("Нет готового ролика");
  ep.approval = { requestedAt: new Date().toISOString() };

  if (telegramEnabled()) {
    const chat = config.telegram.adminChatId;
    const messageId = await sendVideo(chat, episodeFile(ep, ep.final), videoCaption(ep), approvalKeyboard(ep.id));
    await sendMessage(chat, scriptText(ep, series));
    ep.approval.telegramMessageId = messageId;
    log.agent(AGENT, "ролик отправлен тебе в Telegram");
  } else {
    log.agent(
      AGENT,
      `ролик готов: ${episodeFile(ep, ep.final)}\n` +
        `   Одобрить:   npm run studio -- approve ${ep.id}\n` +
        `   Переделать: npm run studio -- redo ${ep.id} "что исправить"\n` +
        `   Отклонить:  npm run studio -- reject ${ep.id}`,
    );
  }
  ep.status = "awaiting_approval";
}
