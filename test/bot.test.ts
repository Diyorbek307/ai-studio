import assert from "node:assert/strict";
import { test } from "node:test";
import { isolate } from "./helpers.js";

// Telegram подменён: запросы к api.telegram.org записываются и получают успешный ответ.
isolate({ TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_ADMIN_CHAT_ID: "42" });
const calls: { method: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("https://api.telegram.org/")) return realFetch(input, init);
  const method = url.split("/").pop()!;
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
  calls.push({ method, body });
  return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), {
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

const { newEpisode } = await import("../src/pipeline.js");
const { handleUpdate } = await import("../src/bot.js");
const { loadEpisode } = await import("../src/store.js");

async function waitFor(check: () => boolean, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("не дождались");
    await new Promise((r) => setTimeout(r, 200));
  }
}

let id = "";

test("готовый ролик уходит в Telegram с кнопками", async () => {
  const ep = await newEpisode("bozor-seriali");
  id = ep.id;
  assert.equal(ep.status, "awaiting_approval", ep.error);
  const video = calls.find((c) => c.method === "sendVideo");
  assert.ok(video, "ролик не отправлен");
  const form = video.body as FormData;
  assert.equal(form.get("chat_id"), "42");
  assert.match(String(form.get("reply_markup")), new RegExp(`approve:${id}`));
  assert.ok(calls.some((c) => c.method === "sendMessage")); // следом — текст сценария
});

test("кнопки от чужого человека не работают", async () => {
  await handleUpdate({ update_id: 1, callback_query: { id: "cb1", from: { id: 999 }, data: `reject:${id}` } });
  assert.equal(loadEpisode(id).status, "awaiting_approval");
  const answer = calls.findLast((c) => c.method === "answerCallbackQuery");
  assert.equal((answer?.body as { text?: string }).text, "Нет доступа");
});

test("«Переделать» спрашивает правки, а ответ запускает переделку", async () => {
  await handleUpdate({
    update_id: 2,
    callback_query: { id: "cb2", from: { id: 42 }, data: `redo:${id}`, message: { message_id: 1, chat: { id: 42 } } },
  });
  assert.equal(loadEpisode(id).status, "awaiting_feedback");

  const videosBefore = calls.filter((c) => c.method === "sendVideo").length;
  await handleUpdate({ update_id: 3, message: { message_id: 5, chat: { id: 42 }, text: "Больше юмора у Somsa aka" } });
  await waitFor(() => loadEpisode(id).status === "awaiting_approval" && calls.filter((c) => c.method === "sendVideo").length > videosBefore);
  assert.ok(loadEpisode(id).feedback.includes("Продюсер: Больше юмора у Somsa aka"));
});

test("«Одобрить» публикует (без Instagram — готовит к ручной публикации)", async () => {
  await handleUpdate({ update_id: 4, callback_query: { id: "cb3", from: { id: 42 }, data: `approve:${id}` } });
  await waitFor(() => loadEpisode(id).status === "approved");
  assert.equal(loadEpisode(id).publish?.dryRun, true);
});

test("сообщения от чужих бот игнорирует, на /start — только подсказка про кабинет", async () => {
  const before = calls.length;
  await handleUpdate({ update_id: 5, message: { message_id: 6, chat: { id: 777 }, text: "/new" } });
  assert.equal(calls.length, before);
  await handleUpdate({ update_id: 6, message: { message_id: 7, chat: { id: 777 }, text: "/start" } });
  assert.equal(calls.length, before + 1);
  assert.match(String((calls.at(-1)!.body as { text: string }).text), /кабинет/);
});

test("клиент привязывает Telegram кодом, получает серию и одобряет её в чате", async () => {
  const { createClient, telegramLinkCode, getClient } = await import("../src/clients.js");
  const { approveEpisode } = await import("../src/pipeline.js");
  const client = createClient({ brand: "bozor-seriali", contactName: "Дилноза", email: "client@example.uz", plan: "start" });
  const code = telegramLinkCode(client.id);

  await handleUpdate({ update_id: 10, message: { message_id: 10, chat: { id: 555 }, text: "/start 00000000" } });
  assert.match(String((calls.at(-1)!.body as { text: string }).text), /не подошёл/);
  await handleUpdate({ update_id: 11, message: { message_id: 11, chat: { id: 555 }, text: `/start ${code}` } });
  assert.equal(getClient(client.id).telegram?.chatId, "555");

  // Студия одобряет — серия уходит клиенту в его чат с его кнопками.
  const ep = await newEpisode("bozor-seriali");
  assert.equal(ep.status, "awaiting_approval", ep.error);
  const sent = await approveEpisode(ep.id);
  assert.equal(sent.status, "awaiting_client");
  const video = calls.findLast((c) => c.method === "sendVideo")!.body as FormData;
  assert.equal(video.get("chat_id"), "555");
  assert.match(String(video.get("reply_markup")), new RegExp(`capprove:${ep.id}`));
  assert.doesNotMatch(String(video.get("caption")), /\$/); // клиенту не показываем расходы студии

  // Чужой чат не может нажать кнопку клиента.
  await handleUpdate({ update_id: 12, callback_query: { id: "cb9", from: { id: 777 }, data: `capprove:${ep.id}`, message: { message_id: 3, chat: { id: 777 } } } });
  assert.equal(loadEpisode(ep.id).status, "awaiting_client");

  await handleUpdate({ update_id: 13, callback_query: { id: "cb10", from: { id: 555 }, data: `capprove:${ep.id}`, message: { message_id: 3, chat: { id: 555 } } } });
  await waitFor(() => loadEpisode(ep.id).status === "approved");
  const log = loadEpisode(ep.id).approvalLog ?? [];
  assert.deepEqual(log.map((a) => `${a.by}:${a.decision}`), ["studio:approved", "studio:sent_to_client", "client:approved"]);
});
