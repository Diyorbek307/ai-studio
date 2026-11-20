import { budgetSummary } from "./budget.js";
import { assertCanOrder, type Client, clientByChat, ensureInvoices, getClient, linkTelegram, listClients, publicClient, usage } from "./clients.js";
import { config } from "./config.js";
import { audit } from "./audit.js";
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
import { buildWeeklyReport } from "./reports.js";
import { approveEpisode, dailyAll, markAwaitingFeedback, newEpisode, prepareEpisode, redoEpisode, rejectEpisode, runEpisode } from "./pipeline.js";
import { listEpisodes, loadEpisode, loadSeries, loadState, saveState } from "./store.js";
import { analyzeStats, collectStats } from "./agents/statsAnalyst.js";
import { type Episode, STATUS_LABEL } from "./types.js";

const HELP = [
  "🎬 AI-студия",
  "",
  "/new — сделать новую серию",
  "/new <задание> — серия по заданию, например: /new серия к Наврузу, Somsa aka печёт сумаляк",
  "/daily — ежедневный цикл всей студии: статистика, выводы, новые серии, автопилот клиентов",
  "/status — последние эпизоды",
  "/clients — клиенты: тариф, серии, оплаты",
  "/budget — сколько потрачено сегодня",
  "/stats — собрать статистику и выводы",
  "",
  "Под каждым роликом кнопки: ✅ одобрить (и передать клиенту или опубликовать), 🔁 переделать (бот спросит, что исправить), 🗑 отклонить.",
].join("\n");

function clientHelp(client: Client): string {
  const u = usage(client);
  return [
    `🎬 ${client.company} × AI-студия`,
    "",
    "Сюда приходят новые серии вашего сериала на согласование:",
    "✅ Одобрить — серия выйдет в Instagram",
    "✏️ Попросить правки — напишите, что поменять, и студия переделает",
    "",
    "/new <задание> — заказать серию, например: /new скидка 20% на плов в пятницу",
    "/status — ваши серии",
    "/report — итоги прошлой недели",
    "",
    `Тариф: ${u.used} из ${u.limit} серий до ${u.periodEnd}.`,
  ].join("\n");
}

const UNKNOWN_CHAT =
  "Это бот AI-студии. Если вы клиент студии — откройте личный кабинет → «Настройки» → «Подключить Telegram» и отправьте сюда код.";

function statusText(): string {
  const eps = listEpisodes().slice(0, 8);
  if (eps.length === 0) return "Эпизодов пока нет. /new — сделать первый.";
  return eps
    .map((e) => `${STATUS_LABEL[e.status]} · ${e.script?.title ?? "(без названия)"} · $${e.costUsd.toFixed(2)}\n   ${e.id}`)
    .join("\n");
}

function clientStatusText(client: Client): string {
  const eps = listEpisodes()
    .filter((e) => e.series === client.brand && e.status !== "rejected")
    .slice(0, 8);
  if (eps.length === 0) return "Серий пока нет. /new <задание> — заказать первую.";
  return eps
    .map((e) => {
      const mine = e.status === "awaiting_client" || (e.status === "awaiting_feedback" && e.feedbackFrom === "client");
      const label = mine ? "👀 ждёт вашего решения" : e.status === "published" ? "📢 опубликована" : e.status === "approved" ? "✅ одобрена" : "⚙️ в работе";
      const title = mine || e.status === "published" || e.status === "approved" ? (e.script?.title ?? "Серия") : "Новая серия";
      return `${label} · ${title}`;
    })
    .join("\n");
}

function clientsText(): string {
  ensureInvoices();
  const clients = listClients().map((c) => publicClient(c));
  if (clients.length === 0) return "Клиентов пока нет. Добавить — в панели студии, вкладка «Клиенты».";
  return clients
    .map(
      (c) =>
        `${c.status === "active" ? "🟢" : "⏸"} ${c.company} · ${c.planName} $${c.priceUsd}\n   серии ${c.usage.used}/${c.usage.limit} до ${c.usage.periodEnd}` +
        `${c.unpaidUsd ? ` · 💳 не оплачено $${c.unpaidUsd}` : ""}${c.telegramLinked ? "" : " · без Telegram"}`,
    )
    .join("\n");
}

function publishText(ep: Episode): string {
  if (ep.status === "awaiting_client") return "🤝 Передано клиенту на согласование.";
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
      background(chat, "Новая серия", () => newEpisode(undefined, { brief, orderedBy: "Студия" }));
      break;
    }
    case "/daily":
      await sendMessage(chat, "⏳ Запускаю ежедневный цикл.");
      background(chat, "Ежедневный цикл", () => dailyAll());
      break;
    case "/status":
      await sendMessage(chat, statusText());
      break;
    case "/clients":
      await sendMessage(chat, clientsText());
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

async function handleClientCommand(chat: string, client: Client, text: string): Promise<void> {
  const command = text.split(/\s+/)[0]!.split("@")[0]!.toLowerCase();
  if (command === "/new") {
    const brief = text.replace(/^\/new(@\S+)?\s*/i, "").trim();
    if (brief.length < 5) {
      await sendMessage(chat, "Напишите задание после команды, например: /new серия про скидку 20% на плов в пятницу");
      return;
    }
    try {
      assertCanOrder(getClient(client.id));
    } catch (error) {
      await sendMessage(chat, `⛔️ ${errorMessage(error)}`);
      return;
    }
    const ep = prepareEpisode(client.brand, { brief: brief.slice(0, 1000), orderedBy: client.company });
    audit(client.company, "заказал(а) серию в Telegram", ep.id, brief.slice(0, 120));
    await sendMessage(chat, "⏳ Приняли задание. Студия пришлёт серию на согласование, когда она будет готова.");
    if (telegramEnabled()) await sendMessage(config.telegram.adminChatId, `📝 ${client.company} заказал(а) серию: «${brief.slice(0, 300)}»`).catch(() => undefined);
    background(config.telegram.adminChatId, `Серия клиента ${client.company}`, () => runEpisode(ep.id));
    return;
  }
  if (command === "/status") {
    await sendMessage(chat, clientStatusText(client));
    return;
  }
  if (command === "/report") {
    await sendMessage(chat, buildWeeklyReport(getClient(client.id)).text);
    return;
  }
  await sendMessage(chat, clientHelp(client));
}

/** Нажатие кнопки под роликом у клиента: одобрить или попросить правки — только по своим сериям. */
async function handleClientCallback(chat: string, client: Client, action: string, id: string): Promise<void> {
  const ep = loadEpisode(id);
  if (ep.series !== client.brand) return;
  const who = { by: "client" as const, clientId: client.id };
  if (action === "capprove") {
    await sendMessage(chat, "⏳ Спасибо! Публикуем серию.");
    background(chat, "Публикация", async () => {
      const done = await approveEpisode(id, who);
      await sendMessage(chat, done.status === "published" ? "📢 Серия опубликована в Instagram." : "✅ Серия одобрена — студия опубликует её в ближайшее время.");
      if (telegramEnabled()) await sendMessage(config.telegram.adminChatId, `✅ ${client.company} одобрил(а) «${done.script?.title ?? id}». ${publishText(done)}`);
    });
  } else if (action === "credo") {
    markAwaitingFeedback(id, who);
    await sendMessage(chat, "✍️ Напишите одним сообщением, что поменять в серии.");
  }
}

export async function handleUpdate(update: TgUpdate): Promise<void> {
  const admin = config.telegram.adminChatId;

  const cq = update.callback_query;
  if (cq) {
    const chatId = cq.message?.chat.id ?? cq.from.id;
    const [action, id] = (cq.data ?? "").split(":");
    const client = isAdmin(cq.from.id) ? undefined : clientByChat(chatId);
    if (!isAdmin(cq.from.id) && !client) {
      await answerCallback(cq.id, "Нет доступа");
      return;
    }
    await answerCallback(cq.id, "Принято");
    if (cq.message) await removeKeyboard(cq.message.chat.id, cq.message.message_id).catch(() => undefined);
    if (!id || !/^ep-\d{8}-[0-9a-f]{8}$/.test(id)) return;

    if (client) {
      try {
        await handleClientCallback(String(chatId), client, action ?? "", id);
      } catch (error) {
        await sendMessage(String(chatId), `⛔️ ${errorMessage(error)}`);
      }
      return;
    }

    if (action === "approve") {
      await sendMessage(admin, "⏳ Одобряю…");
      background(admin, "Одобрение", async () => sendMessage(admin, publishText(await approveEpisode(id))));
    } else if (action === "reject") {
      await rejectEpisode(id);
      await sendMessage(admin, "🗑 Отклонено.");
    } else if (action === "redo") {
      markAwaitingFeedback(id);
      await sendMessage(admin, "✍️ Напиши одним сообщением, что исправить в серии. Или отправь «-», чтобы просто переписать сценарий заново.");
    }
    return;
  }

  const msg = update.message;
  if (!msg?.text) return;
  const text = msg.text.trim();
  const chat = String(msg.chat.id);

  if (!isAdmin(msg.chat.id)) {
    // Клиент: привязка по коду из кабинета, дальше — его серии.
    const start = /^\/start(?:@\S+)?\s+([0-9A-Fa-f]{8})$/.exec(text) ?? /^([0-9A-Fa-f]{8})$/.exec(text);
    if (start) {
      const linked = linkTelegram(start[1]!, chat);
      if (linked) {
        audit(linked.company, "подключил(а) Telegram");
        await sendMessage(chat, `✅ Telegram подключён к кабинету «${linked.company}».\n\n${clientHelp(linked)}`);
        if (telegramEnabled()) await sendMessage(admin, `🔗 ${linked.company} подключил(а) Telegram.`).catch(() => undefined);
      } else {
        await sendMessage(chat, "Код не подошёл или устарел. Получите новый в кабинете → «Настройки».");
      }
      return;
    }
    const client = clientByChat(chat);
    if (!client) {
      // Чужим бот почти не отвечает: только на /start подсказывает, как подключить кабинет.
      if (/^\/start\b/.test(text)) await sendMessage(chat, UNKNOWN_CHAT);
      return;
    }
    if (text.startsWith("/")) {
      await handleClientCommand(chat, client, text);
      return;
    }
    const pending = listEpisodes().find((e) => e.series === client.brand && e.status === "awaiting_feedback" && e.feedbackFrom === "client");
    if (pending) {
      await sendMessage(chat, "🔁 Приняли правки. Студия переделает серию и пришлёт новый вариант.");
      if (telegramEnabled()) await sendMessage(admin, `✏️ ${client.company} просит правки в «${pending.script?.title ?? pending.id}»: «${text.slice(0, 300)}»`).catch(() => undefined);
      background(chat, "Переделка", () => redoEpisode(pending.id, text, "script", { by: "client", clientId: client.id }));
    } else {
      await sendMessage(chat, clientHelp(client));
    }
    return;
  }

  if (text.startsWith("/")) {
    await handleCommand(admin, text);
    return;
  }

  const pending = listEpisodes().find((e) => e.status === "awaiting_feedback" && e.feedbackFrom !== "client");
  if (pending) {
    await sendMessage(admin, "🔁 Переделываю с учётом правок. Пришлю новый вариант.");
    background(admin, "Переделка", () => redoEpisode(pending.id, text === "-" ? "" : text));
  } else {
    await sendMessage(admin, HELP);
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
