import assert from "node:assert/strict";
import { test } from "node:test";
import { isolate } from "./helpers.js";

isolate({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ADMIN_CHAT_ID: "42" });
const sent: { chat: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("https://api.telegram.org/")) throw new Error(`неожиданный запрос ${url}`);
  const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string };
  sent.push({ chat: String(body.chat_id), text: body.text });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
}) as typeof fetch;

const { lastWeek, buildWeeklyReport, weeklyReportsJob, listReports } = await import("../src/reports.js");
const clients = await import("../src/clients.js");
const { createEpisode, saveEpisode, listEpisodes } = await import("../src/store.js");

test("отчётная неделя — прошлая полная неделя с понедельника", () => {
  assert.deepEqual(lastWeek("2026-11-20"), { start: "2026-11-09", end: "2026-11-16" }); // пятница
  assert.deepEqual(lastWeek("2026-11-23"), { start: "2026-11-16", end: "2026-11-23" }); // понедельник
  assert.deepEqual(lastWeek("2026-11-22"), { start: "2026-11-09", end: "2026-11-16" }); // воскресенье
});

test("отчёт: серии недели, одобрения клиента, публикации, цифры и лучшая серия", () => {
  const c = clients.createClient({ brand: "bozor-seriali", contactName: "Дилноза", email: "boss@bozor.uz", plan: "business", periodStart: "2026-11-01" });
  const mk = (createdAt: string, patch: Record<string, unknown>) => {
    const ep = createEpisode("bozor-seriali");
    Object.assign(ep, { createdAt, ...patch });
    saveEpisode(ep);
  };
  mk("2026-11-17T08:00:00Z", {
    status: "published",
    script: { title: "Juma kuni", scenes: [], caption: "", caption_ru: "", hashtags: [], cliffhanger: "" },
    publish: { at: "2026-11-18T10:00:00Z", mediaId: "1" },
    stats: { fetchedAt: "", metrics: { views: 5200, likes: 400 } },
    approvalLog: [{ ts: "2026-11-18T09:00:00Z", by: "client", decision: "approved" }],
  });
  mk("2026-11-19T08:00:00Z", { status: "published", publish: { at: "2026-11-20T10:00:00Z", mediaId: "2" }, stats: { fetchedAt: "", metrics: { views: 1300, likes: 90 } } });
  mk("2026-11-21T08:00:00Z", { status: "awaiting_client" });
  mk("2026-11-20T08:00:00Z", { status: "rejected" }); // отклонённая студией клиенту не видна
  mk("2026-11-10T08:00:00Z", { status: "published", publish: { at: "2026-11-11T10:00:00Z" } }); // прошлая неделя

  const r = buildWeeklyReport(clients.getClient(c.id), "2026-11-24", listEpisodes());
  assert.deepEqual([r.weekStart, r.weekEnd], ["2026-11-16", "2026-11-23"]);
  assert.deepEqual([r.made, r.approved, r.published, r.waiting], [3, 1, 2, 1]);
  assert.deepEqual(r.metrics, { views: 6500, likes: 490 });
  assert.deepEqual(r.best, { title: "Juma kuni", views: 5200 });
  assert.match(r.text, /Серий сделано: 3/);
  assert.match(r.text, /Просмотры 6\s500 · лайки 490/);
  assert.match(r.text, /Ждут вашего решения: 1/);
  assert.match(r.text, /Тариф «Бизнес»/);
  assert.doesNotMatch(r.text, /\$/); // без денег студии
});

test("рассылка: раз в неделю, в Telegram клиента, только тарифам с отчётом", async () => {
  const c = clients.clientForBrand("bozor-seriali")!;
  clients.linkTelegram(clients.telegramLinkCode(c.id), "777");
  const first = await weeklyReportsJob("2026-11-24");
  assert.equal(first.length, 1);
  assert.equal(first[0]!.sent, true);
  assert.equal(sent.find((m) => m.chat === "777")?.text, first[0]!.text);
  assert.ok(sent.some((m) => m.chat === "42" && /Отчёты за неделю: 1/.test(m.text)));

  assert.equal((await weeklyReportsJob("2026-11-26")).length, 0); // та же неделя — повторно не шлём
  clients.updateClient(c.id, { plan: "start" });
  assert.equal((await weeklyReportsJob("2026-12-01")).length, 0); // у «Старта» отчётов нет
  clients.updateClient(c.id, { plan: "network" });
  assert.equal((await weeklyReportsJob("2026-12-01")).length, 1);
  assert.equal(listReports(c.id).length, 2);
});
