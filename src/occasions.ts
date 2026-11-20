import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { listEpisodes } from "./store.js";

/**
 * Календарь поводов: праздники и сезоны, к которым бренды в Узбекистане делают контент.
 * Автопилот берёт ближайший повод в задание серии — не больше одной серии на повод в год для сериала.
 * Свои даты (день рождения бренда, открытие филиала) — в data/occasions.json, тем же форматом.
 */
export interface Occasion {
  id: string;
  /** Название на узбекском и по-русски — так его видит клиент. */
  name: string;
  /** Дата: "MM-DD" каждый год или полные даты "YYYY-MM-DD" для праздников по лунному календарю. */
  dates: string[];
  /** За сколько дней до праздника автопилот начинает делать серию. */
  leadDays: number;
  /** Задание для Генератора идей. */
  brief: string;
  /** Дата примерная: уточняется ежегодно (лунный календарь). */
  approximate?: boolean;
  /** Только для этих сериалов (свои даты бренда). Пусто — для всех. */
  series?: string[];
}

/** Пятница после четвёртого четверга ноября — «Чёрная пятница». */
function blackFriday(year: number): string {
  const d = new Date(Date.UTC(year, 10, 1));
  const firstThursday = 1 + ((4 - d.getUTCDay() + 7) % 7);
  return `${year}-11-${String(firstThursday + 21 + 1).padStart(2, "0")}`;
}

export const BUILT_IN_OCCASIONS: Occasion[] = [
  { id: "new-year", name: "Yangi yil · Новый год", dates: ["01-01"], leadDays: 6, brief: "Новогодняя серия: герои готовятся к Новому году — ёлка, дастархан, подарки. Тёплый праздничный юмор." },
  { id: "defenders", name: "Vatan himoyachilari kuni · День защитников Родины", dates: ["01-14"], leadDays: 2, brief: "Серия ко Дню защитников Родины (14 января): героини поздравляют мужчин, добрый юмор без насмешки над армией." },
  { id: "women", name: "8-mart · Международный женский день", dates: ["03-08"], leadDays: 5, brief: "Серия к 8 Марта: мужчины-герои готовят сюрприз для героинь, всё идёт не по плану, но заканчивается трогательно." },
  { id: "navruz", name: "Navroʻz · Навруз", dates: ["03-21"], leadDays: 5, brief: "Серия к Наврузу: сумаляк всю ночь, халим, весна, соседи собираются вместе. Праздничный и семейный тон." },
  { id: "ramadan-start", name: "Ramazon · начало Рамадана", dates: ["2027-02-08"], leadDays: 2, approximate: true, brief: "Серия к началу Рамадана: ифтар с соседями, уважительный и тёплый тон, без шуток над постом." },
  { id: "ramazon-hayit", name: "Ramazon hayiti · Рамазан хайит", dates: ["2027-03-10"], leadDays: 3, approximate: true, brief: "Серия к Рамазан хайиту: герои ходят в гости, угощают соседей, поздравляют старших. Уважительный тон." },
  { id: "qurbon-hayit", name: "Qurbon hayiti · Курбан хайит", dates: ["2026-05-27", "2027-05-17"], leadDays: 3, approximate: true, brief: "Серия к Курбан хайиту: щедрость, гости, помощь соседям. Уважительный и тёплый тон." },
  { id: "memory", name: "Xotira va qadrlash kuni · День памяти и почестей", dates: ["05-09"], leadDays: 2, brief: "Серия ко Дню памяти и почестей (9 мая): герои навещают старших и слушают их истории. Без шуток над памятью, тёплый тон." },
  { id: "children", name: "Bolalarni himoya qilish kuni · День защиты детей", dates: ["06-01"], leadDays: 3, brief: "Серия ко Дню защиты детей (1 июня): герои устраивают праздник для детей махалли." },
  { id: "independence", name: "Mustaqillik kuni · День независимости", dates: ["09-01"], leadDays: 4, brief: "Серия ко Дню независимости (1 сентября): флаги, плов на всю махаллю, гордость за страну. Праздничный тон." },
  { id: "school", name: "Yangi oʻquv yili · Начало учебного года", dates: ["09-02"], leadDays: 6, brief: "Серия к началу учебного года: младший герой идёт в школу, родители собирают портфель и волнуются." },
  { id: "teachers", name: "Oʻqituvchilar kuni · День учителя", dates: ["10-01"], leadDays: 3, brief: "Серия ко Дню учителя (1 октября): герои вспоминают своих учителей и поздравляют их." },
  { id: "black-friday", name: "Qora juma · Чёрная пятница", dates: [], leadDays: 3, brief: "Серия к Чёрной пятнице: очереди, скидки, герои спорят, кто купит выгоднее. Если у бренда есть акция — покажи её." },
  { id: "constitution", name: "Konstitutsiya kuni · День Конституции", dates: ["12-08"], leadDays: 2, brief: "Серия ко Дню Конституции (8 декабря): выходной день, герои отдыхают всей семьёй." },
];

function customOccasions(): Occasion[] {
  const file = path.join(config.dataDir, "occasions.json");
  if (!fs.existsSync(file)) return [];
  try {
    const items = (JSON.parse(fs.readFileSync(file, "utf8")) as { items?: Occasion[] }).items ?? [];
    return items.filter((o) => o.id && o.name && Array.isArray(o.dates) && o.brief).map((o) => ({ ...o, leadDays: o.leadDays ?? 3 }));
  } catch {
    return [];
  }
}

export function allOccasions(): Occasion[] {
  return [...BUILT_IN_OCCASIONS, ...customOccasions()];
}

/** Конкретные даты повода в году (YYYY-MM-DD). */
export function occasionDates(o: Occasion, year: number): string[] {
  if (o.id === "black-friday") return [blackFriday(year)];
  return o.dates.flatMap((d) => (/^\d{2}-\d{2}$/.test(d) ? [`${year}-${d}`] : d.startsWith(`${year}-`) ? [d] : []));
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface UpcomingOccasion {
  id: string;
  name: string;
  date: string;
  daysLeft: number;
  brief: string;
  approximate: boolean;
  /** Ключ повода в году: по нему автопилот не делает две серии к одному празднику. */
  key: string;
}

/** Поводы в ближайшие days дней (сегодняшний включительно), по порядку; series — только поводы этого сериала. */
export function upcomingOccasions(today: string, days = 30, series?: string): UpcomingOccasion[] {
  const year = Number(today.slice(0, 4));
  const out: UpcomingOccasion[] = [];
  for (const o of allOccasions()) {
    if (series && o.series?.length && !o.series.includes(series)) continue;
    for (const date of [...occasionDates(o, year), ...occasionDates(o, year + 1)]) {
      const daysLeft = daysBetween(today, date);
      if (daysLeft >= 0 && daysLeft <= days) {
        out.push({ id: o.id, name: o.name, date, daysLeft, brief: o.brief, approximate: Boolean(o.approximate), key: `${o.id}:${date.slice(0, 4)}` });
      }
    }
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

/**
 * Повод для серии автопилота: праздник, до которого осталось не больше его leadDays,
 * и к которому у этого сериала ещё нет серии (отклонённые не считаются).
 */
export function pickOccasion(series: string, today: string): UpcomingOccasion | undefined {
  const lead = new Map(allOccasions().map((o) => [o.id, o.leadDays]));
  const done = new Set(listEpisodes().filter((e) => e.series === series && e.occasion && e.status !== "rejected").map((e) => e.occasion));
  return upcomingOccasions(today, 10, series).find((u) => u.daysLeft <= (lead.get(u.id) ?? 3) && !done.has(u.key));
}
