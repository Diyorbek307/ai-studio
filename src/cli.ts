#!/usr/bin/env node
import { designSeries, needsDesign } from "./agents/characterDesigner.js";
import { designBrandSeries } from "./agents/mascotDesigner.js";
import { trainCharacter, watchSoulTraining } from "./agents/soulTrainer.js";
import { engineStatus } from "./providers/engines.js";
import { STARTER_AGENTS } from "./agents/index.js";
import { analyzeStats, collectStats } from "./agents/statsAnalyst.js";
import { runBot } from "./bot.js";
import { budgetSummary } from "./budget.js";
import { config, describeProviders } from "./config.js";
import { errorMessage, log } from "./log.js";
import { createClient, createInvite, ensureInvoices, getClient, listClients, publicClient } from "./clients.js";
import { buildWeeklyReport, weeklyReportsJob } from "./reports.js";
import { approveEpisode, dailyAll, dailyJob, newEpisode, redoEpisode, rejectEpisode, runEpisode, STEPS, type Step } from "./pipeline.js";
import path from "node:path";
import { buildPreview } from "./preview.js";
import { startScheduler, startServer } from "./server.js";
import { listEpisodes, loadEpisode, loadSeries, seedSeries } from "./store.js";
import { type Episode, STATUS_LABEL } from "./types.js";

const HELP = `AI-студия — агенты, которые делают серии для Instagram Reels.

Команды (npm run studio -- <команда>):
  new [сериал] [--brief "задание"] [--engine cutout|gemini|grok|higgsfield|fal]
                                новая серия (по заданию и выбранным движком) → на одобрение
  brand --company "…" --product "…" [--audience …] [--tone …] [--lang uz|ru|en] [--wishes …]
                                Дизайнер маскотов: сериал под бренд компании-клиента
  engines                       какие движки кадров и видео подключены
  list                          последние эпизоды
  show <id>                     подробности эпизода
  run <id>                      продолжить эпизод с места остановки
  approve <id>                  одобрить и опубликовать
  redo <id> ["правки"] [--from шаг]  переделать (по умолчанию со сценария)
  reject <id>                   отклонить
  design [сериал] [--force]     Дизайнер персонажей: канон внешности героев
  stats [сериал]                собрать статистику Instagram и сделать выводы
  daily [сериал]                ежедневный цикл: статистика → выводы → новые серии
                                (без сериала — вся студия: свой сериал + автопилот клиентов)
  clients                       клиенты: тариф, серии за период, неоплаченные счета
  client-add --brand slug --email почта --contact "Имя" [--plan pilot|start|business|network]
             [--approval studio_then_client|client|studio] [--phone …]
                                подключить компанию к её бренду
  invite <id клиента>           ссылка-приглашение в кабинет (действует 7 дней)
  train <сериал> <герой>        обучить героя в Higgsfield (Soul ID) по его картинкам и дождаться результата
  report <id клиента>           отчёт клиента за прошлую неделю (просмотр, без отправки)
  reports                       отчёты за прошлую неделю всем клиентам (в Telegram и кабинет)
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
      const brief = flag(args, "--brief");
      const engine = flag(args, "--engine");
      log.info(describeProviders());
      const ep = await newEpisode(args[0] ?? config.series, { brief, engine });
      printEpisode(ep);
      return ep.status === "failed" ? 1 : 0;
    }

    case "brand": {
      const company = flag(args, "--company");
      const product = flag(args, "--product");
      if (!company || !product) throw new Error('Нужно: brand --company "Название" --product "что продаёт"');
      const language = (flag(args, "--lang") ?? "uz") as "uz" | "ru" | "en";
      if (!["uz", "ru", "en"].includes(language)) throw new Error("--lang: uz, ru или en");
      const series = await designBrandSeries({
        company,
        product,
        audience: flag(args, "--audience") ?? "Покупатели в Узбекистане, 18–45 лет",
        tone: flag(args, "--tone") ?? "Тёплый семейный юмор",
        language,
        wishes: flag(args, "--wishes"),
      });
      console.log(`Бренд готов: ${series.title} (${series.slug})`);
      for (const c of series.characters) console.log(`- ${c.name}: ${c.role}`);
      console.log(`Первая серия: npm run studio -- new ${series.slug}`);
      return 0;
    }

    case "engines":
      for (const e of engineStatus()) console.log(`${e.label.padEnd(12)} ${e.available ? "подключён" : "нет ключа"}`);
      return 0;

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
      const eps = args[0] ? await dailyJob(args[0]) : await dailyAll();
      for (const ep of eps) printEpisode(ep);
      return eps.some((e) => e.status === "failed") ? 1 : 0;
    }

    case "budget":
      console.log(budgetSummary());
      return 0;

    case "clients": {
      ensureInvoices();
      const clients = listClients().map((c) => publicClient(c));
      if (clients.length === 0) console.log("Клиентов пока нет: client-add --brand … --email … --contact …");
      for (const c of clients) {
        console.log(
          `${c.id} · ${c.company} (${c.brandTitle}) · ${c.planName} $${c.priceUsd} · серии ${c.usage.used}/${c.usage.limit} до ${c.usage.periodEnd}` +
            ` · ${c.status === "active" ? "активен" : "пауза"}${c.unpaidUsd ? ` · не оплачено $${c.unpaidUsd}` : ""}${c.hasLogin ? "" : " · кабинет не открыт"}`,
        );
      }
      return 0;
    }

    case "client-add": {
      const client = createClient({
        brand: flag(args, "--brand") ?? "",
        email: flag(args, "--email") ?? "",
        contactName: flag(args, "--contact") ?? "",
        phone: flag(args, "--phone"),
        plan: flag(args, "--plan") ?? "pilot",
        approval: flag(args, "--approval"),
      });
      console.log(`Клиент ${client.id}: ${client.company}. Приглашение: invite ${client.id}`);
      return 0;
    }

    case "train": {
      const [slug, id] = args;
      if (!slug || !id) throw new Error("Укажи сериал и id героя: train bozor-seriali qovun");
      const started = await trainCharacter(slug, id);
      console.log(`Обучение началось (${started.status}). Жду результат — это может занять время…`);
      const done = await watchSoulTraining(slug, id);
      console.log(done ? `Статус: ${done.status}${done.failReason ? ` — ${done.failReason}` : ""}` : "Не дождались — статус обновится при следующей серии");
      return done?.status === "completed" ? 0 : 1;
    }

    case "report": {
      const id = args[0];
      if (!id) throw new Error("Укажи id клиента (список: clients)");
      console.log(buildWeeklyReport(getClient(id)).text);
      return 0;
    }

    case "reports": {
      const done = await weeklyReportsJob();
      console.log(done.length ? `Отчётов: ${done.length}` : "Новых отчётов нет: за прошлую неделю уже всё отправлено или у тарифов клиентов нет отчётов");
      return 0;
    }

    case "invite": {
      const id = args[0];
      if (!id) throw new Error("Укажи id клиента (список: clients)");
      const { token, expiresAt } = createInvite(id);
      const base = config.server.publicBaseUrl || `http://localhost:${config.server.port}`;
      console.log(`${base}/invite/${token}\nДействует до ${expiresAt.slice(0, 10)}. Отправьте ссылку клиенту — он задаст пароль и попадёт в кабинет.`);
      return 0;
    }

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
