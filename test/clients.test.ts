import assert from "node:assert/strict";
import { test } from "node:test";
import { isolate } from "./helpers.js";

isolate({ IG_USER_ID: "studio-ig", IG_ACCESS_TOKEN: "studio-token" });
const clients = await import("../src/clients.js");
const { billingPeriods, PLANS } = await import("../src/plans.js");
const { createSession, readSession, login, sameOrigin } = await import("../src/auth.js");
const { addLead } = await import("../src/leads.js");

test("периоды тарифа: месяц с переносом на конец месяца, пилот — 7 дней", () => {
  assert.deepEqual(billingPeriods(PLANS.start, "2026-01-31", "2026-03-15"), [
    { start: "2026-01-31", end: "2026-02-28" },
    { start: "2026-02-28", end: "2026-03-31" },
  ]);
  assert.deepEqual(billingPeriods(PLANS.pilot, "2026-11-20", "2026-12-30"), [{ start: "2026-11-20", end: "2026-11-27" }]);
});

test("клиент: проверки при создании, один клиент на бренд", () => {
  assert.throws(() => clients.createClient({ brand: "net-takogo", contactName: "A", email: "a@b.uz", plan: "start" }), /Нет сериала/);
  assert.throws(() => clients.createClient({ brand: "bozor-seriali", contactName: "A", email: "плохая", plan: "start" }), /почту/);
  assert.throws(() => clients.createClient({ brand: "bozor-seriali", contactName: "A", email: "a@b.uz", plan: "gold" }), /тариф/);
  const c = clients.createClient({ brand: "bozor-seriali", contactName: "Дилноза", email: "Boss@Bozor.UZ", plan: "start", periodStart: "2026-11-01" });
  assert.equal(c.email, "boss@bozor.uz");
  assert.equal(c.approval, "studio_then_client");
  assert.throws(() => clients.createClient({ brand: "bozor-seriali", contactName: "B", email: "b@b.uz", plan: "start" }), /уже есть клиент/);
});

test("приглашение одноразовое, пароль хранится только хешем", () => {
  const c = clients.clientForBrand("bozor-seriali")!;
  const { token } = clients.createInvite(c.id);
  assert.ok(!JSON.stringify(clients.getClient(c.id)).includes(token));
  assert.throws(() => clients.acceptInvite(token, "123"), /минимум 8/);
  clients.acceptInvite(token, "pilot-2026!");
  assert.throws(() => clients.acceptInvite(token, "pilot-2026!"), /устарела/);
  assert.ok(clients.getClient(c.id).passwordHash?.startsWith("scrypt$"));
  assert.equal(clients.verifyClientLogin("BOSS@bozor.uz", "pilot-2026!")?.id, c.id);
  assert.equal(clients.verifyClientLogin("boss@bozor.uz", "wrong-pass"), undefined);
  assert.equal(clients.verifyClientLogin("nobody@bozor.uz", "pilot-2026!"), undefined);
});

test("сессия: подпись проверяется, смена пароля выкидывает старые сессии", () => {
  const viewer = login("boss@bozor.uz", "pilot-2026!");
  assert.equal(viewer?.role, "client");
  const token = createSession(viewer!);
  assert.equal(readSession(token)?.role, "client");
  const [body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ r: "owner", e: Date.now() + 1e9 })).toString("base64url");
  assert.equal(readSession(`${forged}.${sig}`), undefined);
  assert.equal(readSession(`${body}.x${sig!.slice(1)}`), undefined);

  const c = clients.clientForBrand("bozor-seriali")!;
  clients.changePassword(c.id, "pilot-2026!", "new-pass-2026");
  assert.equal(readSession(token), undefined);
  assert.equal(login("admin", "что-угодно"), undefined); // пароль владельца не задан — admin не входит
});

test("Origin чужого сайта не проходит, свой и без Origin — проходят", () => {
  const req = (origin?: string) => ({ headers: { host: "studio.uz", ...(origin ? { origin } : {}) } }) as never;
  assert.equal(sameOrigin(req("https://studio.uz")), true);
  assert.equal(sameOrigin(req()), true);
  assert.equal(sameOrigin(req("https://evil.example")), false);
});

test("расход серий, автопилот и счета по периодам", () => {
  const c = clients.clientForBrand("bozor-seriali")!;
  const u = clients.usage(c, "2026-11-20");
  assert.deepEqual({ ...u, used: 0 }, { periodStart: "2026-11-01", periodEnd: "2026-12-01", used: 0, limit: 12, left: 12, daysLeft: 11 });
  // На 20-й день из 30 при 12 сериях в месяц уже должно быть сделано 8.
  assert.equal(clients.autopilotDue(c, "2026-11-20"), 2); // но не больше 2 в день
  clients.updateClient(c.id, { status: "paused" });
  assert.equal(clients.autopilotDue(clients.getClient(c.id), "2026-11-20"), 0);
  assert.throws(() => clients.assertCanOrder(clients.getClient(c.id), "2026-11-20"), /паузе/);
  clients.updateClient(c.id, { status: "active" });

  const invoices = clients.ensureInvoices("2026-12-02").filter((i) => i.clientId === c.id);
  assert.deepEqual(invoices.map((i) => [i.number, i.periodStart, i.amountUsd, i.status]), [
    ["2026-0001", "2026-11-01", 290, "unpaid"],
    ["2026-0002", "2026-12-01", 290, "unpaid"],
  ]);
  assert.equal(clients.ensureInvoices("2026-12-02").length, 2); // повторно не выставляет
  clients.markInvoicePaid(invoices[0]!.id);
  assert.equal(clients.publicClient(clients.getClient(c.id), "2026-12-02").unpaidUsd, 290);
});

test("публикация: бренд клиента — только в Instagram клиента, сериал студии — в аккаунт студии", () => {
  const c = clients.clientForBrand("bozor-seriali")!;
  assert.equal(clients.instagramFor("bozor-seriali"), undefined);
  assert.deepEqual(clients.instagramFor("svoy-serial"), { userId: "studio-ig", token: "studio-token" });
  clients.updateClient(c.id, { instagramUserId: "client-ig", instagramToken: "client-token" });
  assert.deepEqual(clients.instagramFor("bozor-seriali"), { userId: "client-ig", token: "client-token" });
  const pub = clients.publicClient(clients.getClient(c.id));
  assert.equal(pub.instagramConnected, true);
  assert.ok(!JSON.stringify(pub).includes("client-token"));
});

test("Telegram клиента: одноразовый код, неверный код не привязывает", () => {
  const c = clients.clientForBrand("bozor-seriali")!;
  const code = clients.telegramLinkCode(c.id);
  assert.match(code, /^[0-9A-F]{8}$/);
  assert.equal(clients.linkTelegram("DEADBEEF", "100"), undefined);
  assert.equal(clients.linkTelegram(code.toLowerCase(), "100")?.id, c.id);
  assert.equal(clients.linkTelegram(code, "200"), undefined);
  assert.equal(clients.clientByChat(100)?.id, c.id);
});

test("заявка с сайта: проверка телефона и обрезка длинных полей", () => {
  assert.throws(() => addLead({ company: "Lazzat", name: "Дилноза", phone: "abc" }), /телефон/);
  const lead = addLead({ company: "  Lazzat   Somsa ", name: "Дилноза", phone: "+998 90 123-45-67", message: "x".repeat(5000) });
  assert.equal(lead.company, "Lazzat Somsa");
  assert.equal(lead.message?.length, 1000);
});

test("счёт: сумма прописью и страница с реквизитами", async () => {
  const { amountInWords, renderInvoicePage } = await import("../src/invoicePage.js");
  assert.equal(amountInWords(590, "USD"), "Пятьсот девяносто долларов США");
  assert.equal(amountInWords(1201, "USD"), "Одна тысяча двести один доллар США");
  assert.equal(amountInWords(7_552_000, "UZS"), "Семь миллионов пятьсот пятьдесят две тысячи сум");
  assert.equal(amountInWords(12_000, "UZS"), "Двенадцать тысяч сум");

  const c = clients.clientForBrand("bozor-seriali")!;
  clients.updateClient(c.id, { legalName: "ООО «Bozor <Seriali>»", legalInn: "301 234 567" });
  assert.throws(() => clients.updateClient(c.id, { legalInn: "12ab" }), /ИНН/);
  const inv = clients.listInvoices(c.id)[0]!;
  const html = renderInvoicePage(inv, clients.getClient(c.id), "Bozor Seriali");
  assert.ok(html.startsWith("<!doctype html>"));
  assert.match(html, /Счёт на оплату № 2026-000\d/);
  assert.match(html, /ООО «Bozor &lt;Seriali&gt;»/); // экранирование
  assert.match(html, /301234567/);
  assert.match(html, /Двести девяносто долларов США|Пятьсот девяносто долларов США|Одна тысяча двести долларов США/);
});
