import { type Client, clientForBrand } from "../clients.js";
import { config } from "../config.js";
import { errorMessage, log } from "../log.js";
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

/** Кнопки для клиента: без «Отклонить» — клиент либо одобряет, либо просит правки. */
export function clientKeyboard(episodeId: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "✅ Одобрить", callback_data: `capprove:${episodeId}` },
        { text: "✏️ Попросить правки", callback_data: `credo:${episodeId}` },
      ],
    ],
  };
}

/** Подпись для клиента: без расходов студии и внутренних заметок контролёра. */
export function clientCaption(ep: Episode): string {
  return [
    `🎬 ${ep.script?.title ?? "Новая серия"}`,
    ep.idea?.logline ?? "",
    `⏱ ${ep.voice?.total.toFixed(0) ?? "?"} с`,
    "Одобрите — и серия выйдет в Instagram. Нужно что-то поменять — нажмите «Попросить правки» и напишите, что именно.",
  ]
    .filter(Boolean)
    .join("\n\n");
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

/**
 * Отправляет ролик клиенту на согласование: в его Telegram (если привязан) и в кабинет.
 * Сбой Telegram не мешает — ролик всё равно ждёт клиента в кабинете.
 */
export async function sendToClient(ep: Episode, client: Client): Promise<void> {
  if (!ep.final) throw new Error("Нет готового ролика");
  ep.approval = { ...ep.approval, clientRequestedAt: new Date().toISOString() };
  ep.status = "awaiting_client";
  ep.approvalLog = [...(ep.approvalLog ?? []), { ts: new Date().toISOString(), by: "studio", decision: "sent_to_client" }];
  const chat = client.telegram?.chatId;
  if (telegramEnabled() && chat) {
    try {
      await sendVideo(chat, episodeFile(ep, ep.final), clientCaption(ep), clientKeyboard(ep.id));
      log.agent(AGENT, `ролик отправлен клиенту «${client.company}» в Telegram`);
      return;
    } catch (error) {
      log.warn(`Telegram клиента «${client.company}»: ${errorMessage(error)}`);
    }
  }
  log.agent(AGENT, `ролик ждёт клиента «${client.company}» в кабинете`);
}

/**
 * Отправляет готовый ролик на одобрение. Кто согласует, решает настройка клиента:
 * «только клиент» — сразу клиенту, иначе — сначала тебе (в Telegram, если он настроен, иначе подсказка в консоли).
 */
export async function requestApproval(ep: Episode, series: Series): Promise<void> {
  if (!ep.final) throw new Error("Нет готового ролика");
  ep.approval = { requestedAt: new Date().toISOString() };
  const client = clientForBrand(series.slug);
  if (client?.approval === "client") {
    await sendToClient(ep, client);
    return;
  }

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
