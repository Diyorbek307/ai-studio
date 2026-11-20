import { budgetSummary } from "./budget.js";
import { config } from "./config.js";
import {
  answerCallback,
  getUpdates,
  isAdmin,
  removeKeyboard,
  sendMessage,
  telegramEnabled,
  type TgUpdate,
} from "./integrations/telegram.js";
import { errorMessage, log } from "./log.js";
import { approveEpisode, dailyJob, markAwaitingFeedback, newEpisode, redoEpisode, rejectEpisode } from "./pipeline.js";
import { listEpisodes, loadSeries, loadState, saveState } from "./store.js";
import { analyzeStats, collectStats } from "./agents/statsAnalyst.js";
import { type Episode, STATUS_LABEL } from "./types.js";

const HELP = [
  "🎬 AI-студия",
  "",
  "/new — сделать новую серию",
  "/new <задание> — серия по заданию, например: /new серия к Наврузу, Somsa aka печёт сумаляк",
  "/daily — полный ежедневный цикл: статистика, выводы, новые серии",
  "/status — последние эпизоды",
  "/budget — сколько потрачено сегодня",
  "/stats — собрать статистику и выводы",
  "",
  "Под каждым роликом кнопки: ✅ одобрить и опубликовать, 🔁 переделать (бот спросит, что исправить), 🗑 отклонить.",
].join("\n");

function statusText(): string {
  const eps = listEpisodes().slice(0, 8);
  if (eps.length === 0) return "Эпизодов пока нет. /new — сделать первый.";
  return eps
    .map((e) => `${STATUS_LABEL[e.status]} · ${e.script?.title ?? "(без названия)"} · $${e.costUsd.toFixed(2)}\n   ${e.id}`)
    .join("\n");
}

function publishText(ep: Episode): string {
  if (ep.status === "published") return `📢 Опубликовано: ${ep.publish?.permalink ?? ep.publish?.mediaId}`;
  if (ep.error) return `❌ ${ep.error}`;
  return `✅ Одобрено. ${ep.publish?.note ?? ""}`;
}

/** Длинные задачи запускаем без ожидания, чтобы бот продолжал отвечать; порядок держит очередь конвейера. */
function background(chat: string, label: string, task: () => Promise<unknown>): void {
  task().catch(async (error) => {
    log.error(`${label}: ${errorMessage(error)}`);
    await sendMessage(chat, `❌ ${label}: ${errorMessage(error)}`).catch(() => undefined);
  });
}

async function handleCommand(chat: string, text: string): Promise<void> {
  const command = text.split(/\s+/)[0]!.split("@")[0]!.toLowerCase();
  switch (command) {
    case "/start":
    case "/help":
      await sendMessage(chat, HELP);
      break;
    case "/new": {
      const brief = text.replace(/^\/new(@\S+)?\s*/i, "").trim();
      await sendMessage(chat, brief ? `⏳ Делаю серию по заданию: «${brief}». Пришлю ролик, когда будет готов.` : "⏳ Начинаю новую серию. Пришлю ролик, когда будет готов.");
      background(chat, "Новая серия", () => newEpisode(undefined, { brief }));
      break;
    }
    case "/daily":
      await sendMessage(chat, "⏳ Запускаю ежедневный цикл.");
      background(chat, "Ежедневный цикл", () => dailyJob());
      break;
    case "/status":
      await sendMessage(chat, statusText());
      break;
    case "/budget":
      await sendMessage(chat, budgetSummary());
      break;
    case "/stats":
      background(chat, "Статистика", async () => {
        const n = await collectStats(config.series);
        const insights = await analyzeStats(loadSeries(config.series));
        await sendMessage(chat, insights ? `📊 Обновлено роликов: ${n}\n\n${insights.summary_ru}` : `📊 Обновлено роликов: ${n}. Для выводов пока мало данных.`);
      });
      break;
    default:
      await sendMessage(chat, HELP);
  }
}

export async function handleUpdate(update: TgUpdate): Promise<void> {
  const chat = config.telegram.adminChatId;

  const cq = update.callback_query;
  if (cq) {
    if (!isAdmin(cq.from.id)) {
      await answerCallback(cq.id, "Нет доступа");
      return;
    }
    const [action, id] = (cq.data ?? "").split(":");
    await answerCallback(cq.id, "Принято");
    if (cq.message) await removeKeyboard(cq.message.chat.id, cq.message.message_id).catch(() => undefined);
    if (!id) return;

    if (action === "approve") {
      await sendMessage(chat, "⏳ Публикую…");
      background(chat, "Публикация", async () => sendMessage(chat, publishText(await approveEpisode(id))));
    } else if (action === "reject") {
      await rejectEpisode(id);
      await sendMessage(chat, "🗑 Отклонено.");
    } else if (action === "redo") {
      markAwaitingFeedback(id);
      await sendMessage(chat, "✍️ Напиши одним сообщением, что исправить в серии. Или отправь «-», чтобы просто переписать сценарий заново.");
    }
    return;
  }

  const msg = update.message;
  if (!msg?.text || !isAdmin(msg.chat.id)) return; // чужим бот не отвечает
  const text = msg.text.trim();
  if (text.startsWith("/")) {
    await handleCommand(chat, text);
    return;
  }

  const pending = listEpisodes().find((e) => e.status === "awaiting_feedback");
  if (pending) {
    await sendMessage(chat, "🔁 Переделываю с учётом правок. Пришлю новый вариант.");
    background(chat, "Переделка", () => redoEpisode(pending.id, text === "-" ? "" : text));
  } else {
    await sendMessage(chat, HELP);
  }
}

/** Бесконечный цикл чтения сообщений из Telegram (long polling). */
export async function runBot(signal?: AbortSignal): Promise<void> {
  if (!telegramEnabled()) {
    log.info("Telegram не настроен — бот не запущен (нужны TELEGRAM_BOT_TOKEN и TELEGRAM_ADMIN_CHAT_ID)");
    return;
  }
  let offset = loadState().telegramOffset;
  log.info("Telegram-бот слушает команды");
  while (!signal?.aborted) {
    let updates: TgUpdate[];
    try {
      updates = await getUpdates(offset, 50);
    } catch (error) {
      log.warn(`Telegram: ${errorMessage(error)}`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      saveState({ telegramOffset: offset });
      try {
        await handleUpdate(update);
      } catch (error) {
        log.error(`Telegram: ${errorMessage(error)}`);
        await sendMessage(config.telegram.adminChatId, `❌ ${errorMessage(error)}`).catch(() => undefined);
      }
    }
  }
}
