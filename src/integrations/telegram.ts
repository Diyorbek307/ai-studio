import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export interface InlineButton {
  text: string;
  callback_data: string;
}
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };

export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number };
    text?: string;
    reply_to_message?: { message_id: number };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

export function telegramEnabled(): boolean {
  return config.telegram.token !== "" && config.telegram.adminChatId !== "";
}

async function call<T>(method: string, body: Record<string, unknown> | FormData, timeoutMs = 60_000): Promise<T> {
  const url = `https://api.telegram.org/bot${config.telegram.token}/${method}`;
  const init: RequestInit =
    body instanceof FormData
      ? { method: "POST", body }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
  return data.result as T;
}

/** Обрезает текст до лимита Telegram, не разрывая последнее слово. */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), limit - 40)) + "…";
}

export async function sendMessage(chatId: string | number, text: string, keyboard?: InlineKeyboard): Promise<number> {
  const msg = await call<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text: clip(text, 4096),
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  });
  return msg.message_id;
}

export async function sendVideo(chatId: string | number, file: string, caption: string, keyboard?: InlineKeyboard): Promise<number> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", clip(caption, 1024));
  form.append("supports_streaming", "true");
  if (keyboard) form.append("reply_markup", JSON.stringify(keyboard));
  form.append("video", new Blob([fs.readFileSync(file)], { type: "video/mp4" }), path.basename(file));
  const msg = await call<{ message_id: number }>("sendVideo", form, 5 * 60_000);
  return msg.message_id;
}

export async function answerCallback(callbackId: string, text?: string): Promise<void> {
  await call("answerCallbackQuery", { callback_query_id: callbackId, text });
}

export async function removeKeyboard(chatId: string | number, messageId: number): Promise<void> {
  await call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
}

export async function getUpdates(offset: number | undefined, timeoutSec = 50): Promise<TgUpdate[]> {
  return call<TgUpdate[]>(
    "getUpdates",
    { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] },
    (timeoutSec + 15) * 1000,
  );
}

/** Сообщение пришло от владельца студии? Всё остальное бот игнорирует. */
export function isAdmin(chatOrUserId: number | undefined): boolean {
  return chatOrUserId !== undefined && String(chatOrUserId) === config.telegram.adminChatId;
}

let cachedUsername: string | undefined;

/** Имя бота для ссылки t.me/<бот>?start=КОД: из TELEGRAM_BOT_USERNAME или один раз у Telegram (getMe). */
export async function botUsername(): Promise<string | undefined> {
  if (config.telegram.botUsername) return config.telegram.botUsername.replace(/^@/, "");
  if (cachedUsername || !config.telegram.token) return cachedUsername;
  try {
    cachedUsername = (await call<{ username?: string }>("getMe", {}, 10_000)).username;
  } catch {
    // без имени бота клиент просто отправит код вручную
  }
  return cachedUsername;
}

/** @имя канала или числовой id (-100…). */
export function isChannelRef(value: string): boolean {
  return /^@[A-Za-z0-9_]{5,32}$/.test(value) || /^-100\d{5,}$/.test(value);
}

/**
 * Проверяет, что бот может публиковать в канал: канал существует, бот в нём администратор с правом публикации.
 * Возвращает название канала.
 */
export async function checkChannel(chat: string): Promise<string> {
  const info = await call<{ title?: string; type?: string }>("getChat", { chat_id: chat }).catch(() => {
    throw new Error("Канал не найден — проверьте @имя или добавьте бота в канал");
  });
  if (info.type !== "channel") throw new Error("Это не канал");
  const me = await call<{ id: number }>("getMe", {});
  const member = await call<{ status: string; can_post_messages?: boolean }>("getChatMember", { chat_id: chat, user_id: me.id }).catch(() => {
    throw new Error("Бот не добавлен в канал — добавьте его администратором");
  });
  if (member.status !== "administrator" && member.status !== "creator") throw new Error("Сделайте бота администратором канала");
  if (member.status === "administrator" && member.can_post_messages === false) throw new Error("Дайте боту право публиковать сообщения в канале");
  return info.title ?? chat;
}
