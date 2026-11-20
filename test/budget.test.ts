import assert from "node:assert/strict";
import { test } from "node:test";
import { isolate } from "./helpers.js";

// Отдельный процесс: здесь дневной лимит $0.10.
isolate({ DAILY_BUDGET_USD: "0.10" });
const { recordCost, spentToday, assertBudget, BudgetExceededError, localDay } = await import("../src/budget.js");
const { newEpisode, runEpisode } = await import("../src/pipeline.js");

const agent = { no: 35, name: "Генератор ключевых кадров", dept: "Визуал" };

test("расход копится, лимит останавливает работу", () => {
  assert.equal(spentToday(), 0);
  assert.doesNotThrow(() => assertBudget());
  recordCost({ agent, kind: "image", usd: 0.06, detail: "s1" });
  recordCost({ agent, kind: "image", usd: 0.05, detail: "s2" });
  recordCost({ agent, kind: "image", usd: 0, detail: "бесплатно не пишется" });
  assert.equal(Math.round(spentToday() * 100) / 100, 0.11);
  assert.throws(() => assertBudget(), BudgetExceededError);
});

test("эпизод встаёт на паузу, когда кончился бюджет, и не падает", async () => {
  const ep = await newEpisode("bozor-seriali");
  assert.equal(ep.status, "paused_budget");
  assert.equal(ep.step, "idea");
  assert.match(ep.error ?? "", /лимит/);
  const again = await runEpisode(ep.id);
  assert.equal(again.status, "paused_budget");
});

test("день считается в часовом поясе студии", () => {
  // 20:30 UTC 31 декабря — в Ташкенте уже 1 января.
  assert.equal(localDay(new Date("2026-12-31T20:30:00Z"), "Asia/Tashkent"), "2027-01-01");
  assert.equal(localDay(new Date("2026-12-31T20:30:00Z"), "UTC"), "2026-12-31");
});
