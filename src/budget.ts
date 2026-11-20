import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { AgentInfo } from "./log.js";

export class BudgetExceededError extends Error {
  constructor(spent: number, limit: number) {
    super(`Дневной лимит исчерпан: потрачено $${spent.toFixed(2)} из $${limit.toFixed(2)}`);
    this.name = "BudgetExceededError";
  }
}

interface CostEntry {
  ts: string;
  day: string;
  episodeId?: string;
  agent: number;
  kind: "llm" | "image" | "video" | "tts";
  usd: number;
  detail: string;
}

function ledgerFile(): string {
  return path.join(config.dataDir, "costs.jsonl");
}

/** Дата в часовом поясе студии, YYYY-MM-DD. */
export function localDay(date = new Date(), timeZone = config.schedule.timezone): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function recordCost(entry: {
  agent: AgentInfo;
  kind: CostEntry["kind"];
  usd: number;
  detail: string;
  episodeId?: string;
}): void {
  if (entry.usd <= 0) return;
  const line: CostEntry = {
    ts: new Date().toISOString(),
    day: localDay(),
    episodeId: entry.episodeId,
    agent: entry.agent.no,
    kind: entry.kind,
    usd: Math.round(entry.usd * 10000) / 10000,
    detail: entry.detail,
  };
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.appendFileSync(ledgerFile(), JSON.stringify(line) + "\n");
}

function readLedger(): CostEntry[] {
  if (!fs.existsSync(ledgerFile())) return [];
  return fs
    .readFileSync(ledgerFile(), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as CostEntry);
}

export function spentToday(): number {
  const today = localDay();
  return readLedger()
    .filter((e) => e.day === today)
    .reduce((sum, e) => sum + e.usd, 0);
}

export function spentOnEpisode(episodeId: string): number {
  return readLedger()
    .filter((e) => e.episodeId === episodeId)
    .reduce((sum, e) => sum + e.usd, 0);
}

/** Бросает BudgetExceededError, если на сегодня денег уже нет. */
export function assertBudget(): void {
  const spent = spentToday();
  if (spent >= config.budget.dailyUsd) throw new BudgetExceededError(spent, config.budget.dailyUsd);
}

export function budgetSummary(): string {
  const spent = spentToday();
  return `Сегодня потрачено $${spent.toFixed(2)} из $${config.budget.dailyUsd.toFixed(2)}`;
}
