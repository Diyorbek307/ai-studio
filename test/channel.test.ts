import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { isolate } from "./helpers.js";

// Telegram подменён: getChat / getChatMember / sendVideo отвечают как Bot API.
isolate({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ADMIN_CHAT_ID: "42" });
const calls: { method: string; chat?: string }[] = [];
let member = "administrator";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const method = String(input).split("/").pop()!;
  const body = init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(String(init?.body ?? "{}"));
  calls.push({ method, chat: String(body.chat_id ?? "") });
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
  if (method === "getChat") return body.chat_id === "@nobody_here" ? new Response(JSON.stringify({ ok: false, description: "chat not found" })) : ok({ id: -1001, type: "channel", title: "Lazzat Somsa" });
  if (method === "getMe") return ok({ id: 777, username: "studio_bot" });
  if (method === "getChatMember") return ok({ status: member, can_post_messages: true });
  return ok({ message_id: 55 });
}) as typeof fetch;

const { isChannelRef, checkChannel } = await import("../src/integrations/telegram.js");
const clients = await import("../src/clients.js");
const { publishEpisode } = await import("../src/agents/publisher.js");
const { createEpisode, episodeDir, episodeFile, saveEpisode } = await import("../src/store.js");

test("канал: @имя или -100…, бот должен быть админом", async () => {
  assert.ok(isChannelRef("@lazzat_somsa") && isChannelRef("-1001234567890"));
  assert.ok(!isChannelRef("lazzat") && !isChannelRef("@ab") && !isChannelRef("https://t.me/x"));
  assert.equal(await checkChannel("@lazzat_somsa"), "Lazzat Somsa");
  await assert.rejects(checkChannel("@nobody_here"), /не найден/);
  member = "member";
  await assert.rejects(checkChannel("@lazzat_somsa"), /администратором/);
  member = "administrator";
});

test("одобренная серия уходит в канал бренда, повторная публикация не дублирует пост", async () => {
  const c = clients.createClient({ brand: "bozor-seriali", contactName: "Дилноза", email: "boss@bozor.uz", plan: "business" });
  clients.setTelegramChannel(c.id, { chat: "@lazzat_somsa", title: "Lazzat Somsa" });
  const ep = createEpisode("bozor-seriali");
  ep.final = "final.mp4";
  ep.script = { title: "Juma", scenes: [], caption: "Har juma!", caption_ru: "", hashtags: ["#somsa"], cliffhanger: "" };
  fs.mkdirSync(episodeDir(ep.id), { recursive: true });
  fs.writeFileSync(episodeFile(ep, "final.mp4"), "mp4");
  saveEpisode(ep);

  calls.length = 0;
  const first = await publishEpisode(ep);
  assert.deepEqual(first.telegram, { chat: "@lazzat_somsa", messageId: 55 });
  assert.equal(first.dryRun, true); // Instagram клиента не подключён
  assert.match(first.note ?? "", /Опубликовано в Telegram-канале/);
  assert.equal(calls.filter((x) => x.method === "sendVideo" && x.chat === "@lazzat_somsa").length, 1);

  calls.length = 0;
  await publishEpisode(ep); // ep.publish уже содержит пост в канале
  assert.equal(calls.filter((x) => x.method === "sendVideo").length, 0);
});
