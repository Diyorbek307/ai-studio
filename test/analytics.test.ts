import assert from "node:assert/strict";
import { test } from "node:test";
import { isolate } from "./helpers.js";

isolate();
const { buildAnalytics } = await import("../src/analytics.js");
type Client = import("../src/clients.js").Client;
type Invoice = import("../src/clients.js").Invoice;
type Episode = import("../src/types.js").Episode;

const client = (id: string, brand: string, plan: Client["plan"], status: Client["status"] = "active"): Client => ({
  id, brand, company: id.toUpperCase(), contactName: "x", email: `${id}@x.uz`, plan, periodStart: "2026-11-01", approval: "studio_then_client", status, createdAt: "2026-11-01T00:00:00Z",
});
const inv = (clientId: string, periodStart: string, amountUsd: number, paidAt?: string): Invoice => ({
  id: `inv-${periodStart}`, number: "1", clientId, plan: "business", periodStart, periodEnd: periodStart, amountUsd, status: paidAt ? "paid" : "unpaid", issuedAt: periodStart, paidAt,
});
const ep = (series: string, createdAt: string, status: Episode["status"], log: [string, "studio" | "client", string][] = [], extra: Partial<Episode> = {}): Episode => ({
  id: `ep-${Math.random()}`, series, createdAt, updatedAt: createdAt, status, feedback: [], attempts: {}, costUsd: 0,
  approvalLog: log.map(([ts, by, decision]) => ({ ts, by, decision: decision as never })), ...extra,
});

test("аналитика: подписки, оплаты по месяцам, серии по неделям, качество согласования", () => {
  const clients = [client("a", "brand-a", "business"), client("b", "brand-b", "pilot"), client("c", "brand-c", "start", "paused")];
  const invoices = [inv("a", "2026-10-01", 590, "2026-10-03T10:00:00Z"), inv("a", "2026-11-01", 590, "2026-11-02T10:00:00Z"), inv("b", "2026-11-10", 150)];
  const episodes = [
    // одобрена с первого раза, клиент решил за 2 часа
    ep("brand-a", "2026-11-17T08:00:00Z", "approved", [["2026-11-17T10:00:00Z", "studio", "sent_to_client"], ["2026-11-17T12:00:00Z", "client", "approved"]]),
    // была правка, клиент думал 6 и 4 часа
    ep("brand-a", "2026-11-18T08:00:00Z", "published", [
      ["2026-11-18T10:00:00Z", "studio", "sent_to_client"], ["2026-11-18T16:00:00Z", "client", "redo"],
      ["2026-11-19T10:00:00Z", "studio", "sent_to_client"], ["2026-11-19T14:00:00Z", "client", "approved"],
    ], { stats: { fetchedAt: "", metrics: { views: 4200, likes: 300 } } }),
    ep("brand-a", "2026-11-18T09:00:00Z", "awaiting_approval", [], { parentId: "x" }), // языковая версия — не считается
    ep("brand-b", "2026-11-04T08:00:00Z", "failed"),
  ];
  const a = buildAnalytics(clients, invoices, episodes, "2026-11-20");
  assert.equal(a.kpi.mrrUsd, 590); // пилот разовый, клиент на паузе — не в подписках
  assert.equal(a.kpi.paidTotalUsd, 1180);
  assert.equal(a.kpi.paid30Usd, 590);
  assert.equal(a.kpi.unpaidUsd, 150);
  assert.equal(a.kpi.episodes30, 2);
  assert.equal(a.kpi.firstTimeRate, 0.5);
  assert.equal(a.kpi.decisionHours, 4); // медиана 2, 4, 6
  assert.deepEqual(a.months.map((m) => [m.month, m.paidUsd, m.invoicedUsd]).slice(-2), [["2026-10", 590, 590], ["2026-11", 590, 740]]);
  assert.equal(a.months.length, 6);
  assert.deepEqual(a.weeks.at(-1), { weekStart: "2026-11-16", episodes: 2 });
  assert.equal(a.weeks.length, 8);
  assert.deepEqual(a.top.map((t) => t.views), [4200]);
  assert.deepEqual(a.clients.find((c) => c.id === "a")?.paidUsd, 1180);
});
