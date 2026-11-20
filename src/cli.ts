#!/usr/bin/env node
import { designSeries, needsDesign } from "./agents/characterDesigner.js";
import { STARTER_AGENTS } from "./agents/index.js";
import { analyzeStats, collectStats } from "./agents/statsAnalyst.js";
import { runBot } from "./bot.js";
import { budgetSummary } from "./budget.js";
import { config, describeProviders } from "./config.js";
import { errorMessage, log } from "./log.js";
import { approveEpisode, dailyJob, newEpisode, redoEpisode, rejectEpisode, runEpisode, STEPS, type Step } from "./pipeline.js";
import path from "node:path";
import { buildPreview } from "./preview.js";
import { startScheduler, startServer } from "./server.js";
import { listEpisodes, loadEpisode, loadSeries, seedSeries } from "./store.js";
import { type Episode, STATUS_LABEL } from "./types.js";

const HELP = `AI-студия — агенты, которые делают серии для Instagram Reels.

Команды (npm run studio -- <команда>):
  new [сериал]                  сделать новую серию и отправить на одобрение
  list                          последние эпизоды
  show <id>                     подробности эпизода
  run <id>                      продолжить эпизод с места остановки
  approve <id>                  одобрить и опубликовать
  redo <id> ["правки"] [--from шаг]  переделать (по умолчанию со сценария)
  reject <id>                   отклонить
  design [сериал] [--force]     Дизайнер персонажей: канон внешности героев
  stats [сериал]                собрать статистику Instagram и сделать выводы
  daily [сериал]                ежедневный цикл: статистика → выводы → новые серии
  serve                         сервер + панель + Telegram-бот + расписание
  budget                        расход за сегодня
  preview [папка]               превью интерфейса без сервера (снимок данных + ролики)
  agents                        список стартовых агентов

Шаги конвейера: ${STEPS.join(" → ")}`;

function printEpisode(ep: Episode): void {
  console.log(`${ep.id} · ${STATUS_LABEL[ep.status]}${ep.step ? ` · шаг ${ep.step}` : ""} · $${ep.costUsd.toFixed(2)}`);
  if (ep.script) console.log(`  «${ep.script.title}» — ${ep.idea?.logline ?? ""}`);
  if (ep.error) console.log(`  ошибка: ${ep.error}`);
  if (ep.final) console.log(`  ролик: data/episodes/${ep.id}/${ep.final}`);
  if (ep.qa) console.log(`  проверка: ${ep.qa.pass ? "пройдена" : "есть замечания"} — ${ep.qa.review.summary_ru}`);
  if (ep.publish) console.log(`  публикация: ${ep.publish.permalink ?? ep.publish.note ?? ep.publish.mediaId}`);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

async function main(argv: string[]): Promise<number> {
  const [command = "help", ...args] = argv;
  seedSeries();
  const need = (what: string): string => {
    const value = args[0];
    if (!value) throw new Error(`Укажи ${what}`);
    return value;
  };

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;

    case "agents":
      for (const a of STARTER_AGENTS) console.log(`№${String(a.no).padStart(2)}  ${a.name.padEnd(26)} ${a.does}`);
      return 0;

    case "new": {
      log.info(describeProviders());
      const ep = await newEpisode(args[0] ?? config.series);
      printEpisode(ep);
      return ep.status === "failed" ? 1 : 0;
    }

    case "list": {
      const eps = listEpisodes();
      if (eps.length === 0) console.log("Эпизодов пока нет: npm run studio -- new");
      for (const ep of eps.slice(0, 20)) printEpisode(ep);
      return 0;
    }

    case "show": {
      const ep = loadEpisode(need("id эпизода"));
      console.log(JSON.stringify(ep, null, 2));
      return 0;
    }

    case "run": {
      const ep = await runEpisode(need("id эпизода"));
      printEpisode(ep);
      return ep.status === "failed" ? 1 : 0;
    }

    case "approve":
    case "publish": {
      const ep = await approveEpisode(need("id эпизода"));
      printEpisode(ep);
      return ep.error ? 1 : 0;
    }

    case "redo": {
      const from = (flag(args, "--from") ?? "script") as Step;
      if (!STEPS.includes(from)) throw new Error(`Нет шага «${from}». Шаги: ${STEPS.join(", ")}`);
      const id = need("id эпизода");
      const ep = await redoEpisode(id, args.slice(1).join(" "), from);
      printEpisode(ep);
      return ep.status === "failed" ? 1 : 0;
    }

    case "reject":
      printEpisode(await rejectEpisode(need("id эпизода")));
      return 0;

    case "design": {
      const force = args.includes("--force");
      const slug = args.find((a) => !a.startsWith("--")) ?? config.series;
      const before = loadSeries(slug);
      if (!force && !needsDesign(before)) {
        log.info("Канон уже есть. Чтобы написать заново: design --force");
      }
      const series = await designSeries(before, { force });
      console.log(`Стиль: ${series.style_prompt}`);
      for (const c of series.characters) console.log(`- ${c.name}: ${c.visual_prompt}`);
      return 0;
    }

    case "stats": {
      const slug = args[0] ?? config.series;
      await collectStats(slug);
      const insights = await analyzeStats(loadSeries(slug));
      if (insights) console.log(JSON.stringify(insights, null, 2));
      return 0;
    }

    case "daily": {
      log.info(describeProviders());
      const eps = await dailyJob(args[0] ?? config.series);
      for (const ep of eps) printEpisode(ep);
      return eps.some((e) => e.status === "failed") ? 1 : 0;
    }

    case "budget":
      console.log(budgetSummary());
      return 0;

    case "preview": {
      const out = buildPreview(path.resolve(args[0] ?? "preview"));
      console.log(`Превью: ${out.page} (+ ${out.media.length} файлов)`);
      return 0;
    }

    case "serve": {
      log.info(describeProviders());
      startServer();
      startScheduler();
      void runBot();
      return new Promise<number>(() => undefined); // работает, пока процесс не остановят
    }

    default:
      console.log(`Неизвестная команда «${command}».\n\n${HELP}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    log.error(errorMessage(error));
    process.exit(1);
  },
);
