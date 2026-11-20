/** Тарифы студии — те же, что в документе «AI-студия: бизнес-модель». */
export const PLAN_IDS = ["pilot", "start", "business", "network"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface Plan {
  id: PlanId;
  name: string;
  priceUsd: number;
  /** Сколько серий входит в период. */
  episodes: number;
  /** Пилот — разовый период в днях, остальные — календарный месяц. */
  period: "once" | "month";
  days?: number;
  features: string[];
}

export const PLANS: Record<PlanId, Plan> = {
  pilot: {
    id: "pilot",
    name: "Пилот",
    priceUsd: 150,
    episodes: 5,
    period: "once",
    days: 7,
    features: ["Маскот и сериал под бренд", "5 серий за неделю", "Без подписки"],
  },
  start: {
    id: "start",
    name: "Старт",
    priceUsd: 290,
    episodes: 12,
    period: "month",
    features: ["12 серий в месяц, 3 в неделю", "1 маскот, 1 язык", "Публикация в Instagram"],
  },
  business: {
    id: "business",
    name: "Бизнес",
    priceUsd: 590,
    episodes: 30,
    period: "month",
    features: ["Серия каждый день", "Серии под ваши акции и праздники", "Instagram и Telegram", "Отчёт раз в неделю"],
  },
  network: {
    id: "network",
    name: "Сеть",
    priceUsd: 1200,
    episodes: 60,
    period: "month",
    features: ["2 серии в день", "2 языка, до 3 маскотов", "Серии под филиалы", "Приоритет в очереди"],
  },
};

export function isPlan(value: string): value is PlanId {
  return (PLAN_IDS as readonly string[]).includes(value);
}

/** Добавляет к дате (YYYY-MM-DD) месяцы или дни, возвращает YYYY-MM-DD. */
function shift(day: string, opts: { months?: number; days?: number }): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (opts.months) {
    const target = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + opts.months);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(target, last));
  }
  if (opts.days) d.setUTCDate(d.getUTCDate() + opts.days);
  return d.toISOString().slice(0, 10);
}

/**
 * Периоды оплаты от даты старта до сегодня включительно: [начало, конец).
 * У пилота один период, у подписки — помесячные периоды, последний из них текущий.
 */
export function billingPeriods(plan: Plan, startDay: string, today: string): { start: string; end: string }[] {
  if (plan.period === "once") return [{ start: startDay, end: shift(startDay, { days: plan.days ?? 7 }) }];
  const out: { start: string; end: string }[] = [];
  for (let i = 0; i < 240; i++) {
    const start = shift(startDay, { months: i });
    if (start > today) break;
    out.push({ start, end: shift(startDay, { months: i + 1 }) });
  }
  return out.length ? out : [{ start: startDay, end: shift(startDay, { months: 1 }) }];
}

export function currentPeriod(plan: Plan, startDay: string, today: string): { start: string; end: string } {
  return billingPeriods(plan, startDay, today).at(-1)!;
}
