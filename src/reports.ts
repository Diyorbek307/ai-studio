import crypto from "node:crypto";
import { audit } from "./audit.js";
import { localDay } from "./budget.js";
import { type Client, listClients, usage } from "./clients.js";
import { config } from "./config.js";
import { readCollection, writeCollection } from "./db.js";
import { sendMessage, telegramEnabled } from "./integrations/telegram.js";
import { errorMessage, log } from "./log.js";
import { upcomingOccasions } from "./occasions.js";
import { PLANS } from "./plans.js";
import { listEpisodes, loadInsights, loadSeries } from "./store.js";
import type { Episode } from "./types.js";

/**
 * Еженедельный отчёт клиенту: что студия сделала за прошлую неделю (пн–вс), что вышло в Instagram,
 * какие цифры, что ждёт решения и какие праздники впереди. Уходит клиенту в Telegram и хранится в кабинете.
 */
export interface WeeklyReport {
  id: string;
  clientId: string;
  /** Понедельник отчётной недели и понедельник следующей (не включительно), YYYY-MM-DD. */
  weekStart: string;
  weekEnd: string;
  createdAt: string;
  made: number;
  approved: number;
  published: number;
  waiting: number;
  metrics: Record<string, number>;
  best?: { title: string; views: number };
  insight?: string;
  occasions: string[];
  usage: { used: number; limit: number; periodEnd: string };
  text: string;
  /** Отправлен ли клиенту в Telegram. */
  sent: boolean;
}

const REPORTS = "reports";
const METRIC_LABEL: [string, string][] = [
  ["views", "просмотры"],
  ["reach", "охват"],
  ["likes", "лайки"],
  ["comments", "комментарии"],
  ["shares", "репосты"],
  ["saved", "сохранения"],
];

function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Понедельник прошлой недели относительно today: отчёт всегда за полную неделю пн–вс. */
export function lastWeek(today: string): { start: string; end: string } {
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // пн = 0
  const thisMonday = shiftDay(today, -weekday);
  return { start: shiftDay(thisMonday, -7), end: thisMonday };
}

const inWeek = (iso: string | undefined, start: string, end: string): boolean => {
  if (!iso) return false;
  const day = localDay(new Date(iso));
  return day >= start && day < end;
};

const fmt = (n: number) => n.toLocaleString("ru-RU");
const ruDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });

export function buildWeeklyReport(client: Client, today = localDay(), episodes: Episode[] = listEpisodes()): WeeklyReport {
  const { start, end } = lastWeek(today);
  const own = episodes.filter((e) => e.series === client.brand && e.status !== "rejected");
  const made = own.filter((e) => e.status !== "failed" && inWeek(e.createdAt, start, end)).length;
  const approved = own.filter((e) => (e.approvalLog ?? []).some((a) => a.decision === "approved" && a.by === "client" && inWeek(a.ts, start, end))).length;
  const publishedEps = own.filter((e) => e.status === "published" && inWeek(e.publish?.at, start, end));
  const waiting = own.filter((e) => e.status === "awaiting_client" || (e.status === "awaiting_feedback" && e.feedbackFrom === "client")).length;

  // Цифры — по сериям, опубликованным за неделю (статистику собирает Аналитик № 91).
  const metrics: Record<string, number> = {};
  for (const e of publishedEps) for (const [k, v] of Object.entries(e.stats?.metrics ?? {})) metrics[k] = (metrics[k] ?? 0) + v;
  const bestEp = publishedEps.filter((e) => e.stats?.metrics.views).sort((a, b) => (b.stats!.metrics.views ?? 0) - (a.stats!.metrics.views ?? 0))[0];

  let insight: string | undefined;
  let title = client.brand;
  try {
    title = loadSeries(client.brand).title;
    insight = loadInsights(client.brand)?.summary_ru;
  } catch {
    // сериал удалён вручную — отчёт без названия и выводов
  }
  const occasions = upcomingOccasions(today, 21, client.brand).map((o) => `${o.name.split(" · ").pop()} (${ruDay(o.date)})`);
  const u = usage(client, today);
  const plan = PLANS[client.plan];

  const metricLine = METRIC_LABEL.filter(([k]) => metrics[k] !== undefined)
    .map(([k, label]) => `${label} ${fmt(metrics[k]!)}`)
    .join(" · ");
  const lines = [
    `📊 ${client.company} · ${plan.period === "once" ? "итоги пилота" : "неделя"} ${ruDay(start)} — ${ruDay(shiftDay(end, -1))}`,
    `Сериал «${title}»`,
    "",
    `🎬 Серий сделано: ${made}`,
    `✅ Вы одобрили: ${approved} · 📢 опубликовано: ${publishedEps.length}`,
    waiting ? `👀 Ждут вашего решения: ${waiting} — откройте кабинет или нажмите кнопки под роликами` : "",
    metricLine ? `📈 ${metricLine.charAt(0).toUpperCase()}${metricLine.slice(1)}` : "",
    bestEp ? `🏆 Лучшая серия: «${bestEp.script?.title ?? bestEp.id}» — ${fmt(bestEp.stats!.metrics.views!)} просмотров` : "",
    insight ? `💡 ${insight}` : "",
    occasions.length ? `🗓 Скоро: ${occasions.join(", ")} — студия сделает серии к этим датам. Есть акция? Пришлите задание: /new …` : "",
    "",
    plan.period === "once"
      ? `Пилот: ${u.used} из ${u.limit} серий. Понравилось? Напишите студии — продолжим по месячному тарифу.`
      : `Тариф «${plan.name}»: ${u.used} из ${u.limit} серий, период до ${ruDay(shiftDay(u.periodEnd, -1))}.`,
  ];
  return {
    id: `rep-${crypto.randomBytes(4).toString("hex")}`,
    clientId: client.id,
    weekStart: start,
    weekEnd: end,
    createdAt: new Date().toISOString(),
    made,
    approved,
    published: publishedEps.length,
    waiting,
    metrics,
    best: bestEp ? { title: bestEp.script?.title ?? bestEp.id, views: bestEp.stats!.metrics.views! } : undefined,
    insight,
    occasions,
    usage: { used: u.used, limit: u.limit, periodEnd: u.periodEnd },
    text: lines.filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== "")).join("\n").trim(),
    sent: false,
  };
}

export function listReports(clientId?: string): WeeklyReport[] {
  const all = readCollection<WeeklyReport>(REPORTS);
  return (clientId ? all.filter((r) => r.clientId === clientId) : all).sort((a, b) => b.weekStart.localeCompare(a.weekStart));
}

/**
 * Отчёты за прошлую неделю всем клиентам с отчётами в тарифе (раз в неделю: если отчёт уже есть — пропуск).
 * Клиент должен был работать со студией хотя бы часть той недели.
 */
export async function weeklyReportsJob(today = localDay()): Promise<WeeklyReport[]> {
  const { start, end } = lastWeek(today);
  const all = readCollection<WeeklyReport>(REPORTS);
  const fresh: WeeklyReport[] = [];
  for (const client of listClients()) {
    if (client.status !== "active" || !PLANS[client.plan].weeklyReport) continue;
    if (client.periodStart >= end) continue; // ещё не работали на той неделе
    if (all.some((r) => r.clientId === client.id && r.weekStart === start)) continue;
    const report = buildWeeklyReport(client, today);
    const chat = client.telegram?.chatId;
    if (telegramEnabled() && chat) {
      try {
        await sendMessage(chat, report.text);
        report.sent = true;
      } catch (error) {
        log.warn(`Отчёт «${client.company}» в Telegram: ${errorMessage(error)}`);
      }
    }
    all.push(report);
    fresh.push(report);
    audit("Студия", report.sent ? "отправила отчёт за неделю" : "подготовила отчёт за неделю", client.company, `${report.made} серий, ${report.published} в Instagram`);
  }
  if (fresh.length) {
    writeCollection(REPORTS, all);
    if (telegramEnabled()) {
      const sent = fresh.filter((r) => r.sent).length;
      await sendMessage(config.telegram.adminChatId, `📊 Отчёты за неделю: ${fresh.length} (в Telegram клиентам — ${sent}, остальные в кабинетах).`).catch(() => undefined);
    }
  }
  return fresh;
}
