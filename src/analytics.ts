import { localDay } from "./budget.js";
import { type Client, type Invoice, usage } from "./clients.js";
import { PLANS } from "./plans.js";
import type { Episode } from "./types.js";

/**
 * Цифры студии для владельца: деньги по месяцам, серии по неделям, качество согласования
 * (сколько серий одобрено с первого раза и как быстро клиенты решают) и лучшие серии.
 */
export interface StudioAnalytics {
  kpi: {
    mrrUsd: number;
    paid30Usd: number;
    paidTotalUsd: number;
    unpaidUsd: number;
    episodes30: number;
    firstTimeRate?: number;
    decisionHours?: number;
  };
  months: { month: string; paidUsd: number; invoicedUsd: number }[];
  weeks: { weekStart: string; episodes: number }[];
  clients: {
    id: string;
    company: string;
    planName: string;
    used: number;
    limit: number;
    firstTimeRate?: number;
    decisionHours?: number;
    paidUsd: number;
  }[];
  top: { id: string; title: string; brand: string; views: number; likes?: number }[];
}

function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Серии, по которым решение уже принято: доля без единой просьбы переделать. */
function firstTimeRate(eps: Episode[]): number | undefined {
  const decided = eps.filter((e) => !e.parentId && (e.status === "approved" || e.status === "published"));
  if (!decided.length) return undefined;
  const clean = decided.filter((e) => !(e.approvalLog ?? []).some((a) => a.decision === "redo")).length;
  return clean / decided.length;
}

/** Сколько часов клиент думает: от «передала клиенту» до его решения (медиана). */
function decisionHours(eps: Episode[]): number | undefined {
  const waits: number[] = [];
  for (const e of eps) {
    let sent: number | undefined;
    for (const a of e.approvalLog ?? []) {
      if (a.decision === "sent_to_client") sent = Date.parse(a.ts);
      else if (a.by === "client" && sent !== undefined) {
        waits.push((Date.parse(a.ts) - sent) / 3_600_000);
        sent = undefined;
      }
    }
  }
  const m = median(waits);
  return m === undefined ? undefined : Math.round(m * 10) / 10;
}

export function buildAnalytics(clients: Client[], invoices: Invoice[], episodes: Episode[], today = localDay()): StudioAnalytics {
  const monthOf = (iso: string) => localDay(new Date(iso)).slice(0, 7);
  const months: StudioAnalytics["months"] = [];
  const [y, m] = today.split("-").map(Number) as [number, number];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const month = d.toISOString().slice(0, 7);
    months.push({
      month,
      paidUsd: invoices.filter((inv) => inv.status === "paid" && inv.paidAt && monthOf(inv.paidAt) === month).reduce((s, inv) => s + inv.amountUsd, 0),
      invoicedUsd: invoices.filter((inv) => inv.periodStart.slice(0, 7) === month).reduce((s, inv) => s + inv.amountUsd, 0),
    });
  }

  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const thisMonday = shiftDay(today, -weekday);
  const originals = episodes.filter((e) => !e.parentId && e.status !== "failed");
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const start = shiftDay(thisMonday, -7 * (7 - i));
    const end = shiftDay(start, 7);
    return { weekStart: start, episodes: originals.filter((e) => { const d = localDay(new Date(e.createdAt)); return d >= start && d < end; }).length };
  });

  const monthAgo = shiftDay(today, -30);
  const paid = invoices.filter((i) => i.status === "paid");
  const byClient = (c: Client) => episodes.filter((e) => e.series === c.brand);

  return {
    kpi: {
      mrrUsd: clients.filter((c) => c.status === "active" && PLANS[c.plan].period === "month").reduce((s, c) => s + PLANS[c.plan].priceUsd, 0),
      paid30Usd: paid.filter((i) => i.paidAt && localDay(new Date(i.paidAt)) >= monthAgo).reduce((s, i) => s + i.amountUsd, 0),
      paidTotalUsd: paid.reduce((s, i) => s + i.amountUsd, 0),
      unpaidUsd: invoices.filter((i) => i.status === "unpaid").reduce((s, i) => s + i.amountUsd, 0),
      episodes30: originals.filter((e) => localDay(new Date(e.createdAt)) >= monthAgo).length,
      firstTimeRate: firstTimeRate(episodes.filter((e) => clients.some((c) => c.brand === e.series))),
      decisionHours: decisionHours(episodes),
    },
    months,
    weeks,
    clients: clients.map((c) => {
      const u = usage(c, today, episodes);
      const own = byClient(c);
      return {
        id: c.id,
        company: c.company,
        planName: PLANS[c.plan].name,
        used: u.used,
        limit: u.limit,
        firstTimeRate: firstTimeRate(own),
        decisionHours: decisionHours(own),
        paidUsd: paid.filter((i) => i.clientId === c.id).reduce((s, i) => s + i.amountUsd, 0),
      };
    }),
    top: episodes
      .filter((e) => e.status === "published" && (e.stats?.metrics.views ?? 0) > 0)
      .sort((a, b) => (b.stats!.metrics.views ?? 0) - (a.stats!.metrics.views ?? 0))
      .slice(0, 5)
      .map((e) => ({ id: e.id, title: e.script?.title ?? e.id, brand: e.series, views: e.stats!.metrics.views!, likes: e.stats!.metrics.likes })),
  };
}
