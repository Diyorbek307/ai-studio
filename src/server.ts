import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { audit } from "./audit.js";
import {
  clearSessionCookie,
  clientIp,
  createSession,
  login,
  rateLimit,
  resetRateLimit,
  sameOrigin,
  sessionCookie,
  type Viewer,
  viewerFrom,
} from "./auth.js";
import { budgetSummary, localDay } from "./budget.js";
import {
  acceptInvite,
  assertCanOrder,
  changePassword,
  clientByInvite,
  createClient,
  createInvite,
  getClient,
  listInvoices,
  markInvoicePaid,
  telegramLinkCode,
  updateClient,
} from "./clients.js";
import { config, describeProviders } from "./config.js";
import { renderInvoicePage } from "./invoicePage.js";
import { addLead } from "./leads.js";
import { errorMessage, log } from "./log.js";
import { designBrandSeries } from "./agents/mascotDesigner.js";
import { trainCharacter, watchSoulTraining } from "./agents/soulTrainer.js";
import { botUsername, sendMessage, telegramEnabled } from "./integrations/telegram.js";
import { type AssetKind, characterAsset, type CharacterVariant, isCharacterVariant, locationAsset, saveAsset } from "./media/cutout.js";
import { approveEpisode, dailyAll, prepareEpisode, redoEpisode, rejectEpisode, runEpisode } from "./pipeline.js";
import { PLAN_IDS, PLANS } from "./plans.js";
import { BUNDLED_SERIES_DIR, episodeDir, loadEpisode, loadSeries, loadState, saveState } from "./store.js";
import { buildStudioState } from "./studioState.js";

/** Страницы студии — фрагменты HTML в ui/ (от dist/src/ это ../../ui). */
export const UI_FILE = fileURLToPath(new URL("../../ui/app.html", import.meta.url));
export const LANDING_FILE = fileURLToPath(new URL("../../ui/landing.html", import.meta.url));
export const LOGIN_FILE = fileURLToPath(new URL("../../ui/login.html", import.meta.url));

/** Обёртка документа вокруг фрагмента из ui/ (сами фрагменты публикуются и как превью). */
export function renderAppPage(fragment: string, title = "AI-студия", inject?: Record<string, unknown>): string {
  let body = fragment;
  if (inject) {
    const at = body.lastIndexOf("<script>");
    const data = Object.entries(inject)
      .map(([k, v]) => `window.${k} = ${JSON.stringify(v).replace(/</g, "\\u003c")};`)
      .join("\n");
    if (at !== -1) body = `${body.slice(0, at)}<script>${data}</script>\n${body.slice(at)}`;
  }
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="same-origin">
<title>${title}</title>
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** Какие файлы эпизода доступны по публичной ссылке: готовый ролик и ключевые кадры. */
export function publicMediaPath(id: string, file: string): string | undefined {
  if (!/^(final\.mp4|keyframes\/s\d{1,2}\.png)$/.test(file)) return undefined;
  try {
    const full = path.join(episodeDir(id), file);
    return fs.existsSync(full) ? full : undefined;
  } catch {
    return undefined;
  }
}

/** Картинка демо-сериала из кода студии (не из данных клиентов). */
export function showcaseFile(kind: string, id: string): string | undefined {
  const file = path.join(BUNDLED_SERIES_DIR, "assets", "bozor-seriali", kind, `${id}.png`);
  return fs.existsSync(file) ? file : undefined;
}

function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, cache = "no-cache"): void {
  const size = fs.statSync(file).size;
  const type = file.endsWith(".mp4") ? "video/mp4" : "image/png";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start < 0) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": cache,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes", "Cache-Control": cache });
  fs.createReadStream(file).pipe(res);
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
};

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res
    .writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers })
    .end(JSON.stringify(body));
}

function html(res: http.ServerResponse, page: string, status = 200): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS }).end(page);
}

function redirect(res: http.ServerResponse, to: string): void {
  res.writeHead(303, { Location: to, "Cache-Control": "no-store" }).end();
}

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 20_000) throw new Error("Слишком большой запрос");
  }
  return new URLSearchParams(body);
}

/** Тело запроса во временный файл (загрузка картинок), не больше limit байт. */
async function readUpload(req: http.IncomingMessage, limit = 12 * 1024 * 1024): Promise<string> {
  const type = String(req.headers["content-type"] ?? "");
  if (!/^image\/(png|jpeg|webp)$/.test(type)) throw new Error("Нужна картинка PNG, JPG или WEBP");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("Картинка больше 12 МБ");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) throw new Error("Пустой файл");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "studio-upload-")), `in.${type.split("/")[1]}`);
  fs.writeFileSync(file, Buffer.concat(chunks));
  return file;
}

/** Запускает долгую задачу в фоне: интерфейс сразу получает ответ, а ход работы видит через /api/state. */
function background(label: string, task: Promise<unknown>): void {
  task.catch((e) => log.error(`${label}: ${errorMessage(e)}`));
}

function page(file: string, title: string, inject?: Record<string, unknown>): string {
  return renderAppPage(fs.readFileSync(file, "utf8"), title, inject);
}

function publicInfo(): Record<string, unknown> {
  return { plans: PLAN_IDS.map((id) => PLANS[id]) };
}

/** Короткое имя для журнала действий. */
function actorName(viewer: Viewer): string {
  return viewer.role === "owner" ? "Студия" : viewer.client.company;
}

/** Уведомление владельцу в Telegram — без ошибок наружу. */
async function notifyOwner(text: string): Promise<void> {
  if (!telegramEnabled()) return;
  await sendMessage(config.telegram.adminChatId, text).catch((e) => log.warn(`Telegram: ${errorMessage(e)}`));
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function ownerOnly(viewer: Viewer): void {
  if (viewer.role !== "owner") throw new HttpError(403, "Нет доступа");
}

/** Клиент может решать только по своим сериям, которые ждут его решения. */
function assertClientEpisode(viewer: Viewer, id: string): void {
  if (viewer.role !== "client") return;
  const ep = loadEpisode(id);
  if (ep.series !== viewer.client.brand) throw new HttpError(404, "Серия не найдена");
  const waiting = ep.status === "awaiting_client" || (ep.status === "awaiting_feedback" && ep.feedbackFrom === "client");
  if (!waiting) throw new HttpError(409, "Эта серия сейчас не ждёт вашего решения");
}

async function handlePublic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === "/health") {
    json(res, 200, { ok: true, providers: describeProviders(), budget: budgetSummary() });
    return true;
  }

  const media = /^\/media\/(ep-\d{8}-[0-9a-f]{8})\/(.+)$/.exec(url.pathname);
  if (media && req.method === "GET") {
    const file = publicMediaPath(media[1]!, media[2]!);
    if (!file) json(res, 404, { error: "not found" });
    else sendFile(req, res, file);
    return true;
  }

  // Герои демо-сериала студии — картинки для сайта, они публичные.
  const showcase = /^\/showcase\/(characters|locations)\/([a-z0-9-]+)\.png$/.exec(url.pathname);
  if (showcase && req.method === "GET") {
    const file = showcaseFile(showcase[1]!, showcase[2]!);
    if (!file) json(res, 404, { error: "not found" });
    else sendFile(req, res, file, "public, max-age=86400");
    return true;
  }

  if (url.pathname === "/" && req.method === "GET") {
    html(res, page(LANDING_FILE, "AI-студия — мультсериал для вашего бренда", { STUDIO_PUBLIC: publicInfo() }));
    return true;
  }

  if (url.pathname === "/login" && req.method === "GET") {
    if (viewerFrom(req) && !url.searchParams.has("switch")) {
      redirect(res, "/app");
      return true;
    }
    html(res, page(LOGIN_FILE, "Вход — AI-студия", { STUDIO_AUTH: { mode: "login" } }));
    return true;
  }

  const invite = /^\/invite\/([A-Za-z0-9_-]{20,64})$/.exec(url.pathname);
  if (invite && req.method === "GET") {
    const client = clientByInvite(invite[1]!);
    html(
      res,
      page(LOGIN_FILE, "Приглашение — AI-студия", {
        STUDIO_AUTH: client ? { mode: "invite", token: invite[1], company: client.company, email: client.email } : { mode: "invite-expired" },
      }),
      client ? 200 : 410,
    );
    return true;
  }

  if (req.method === "POST" && ["/api/login", "/api/logout", "/api/invite", "/api/leads"].includes(url.pathname)) {
    if (!sameOrigin(req)) {
      json(res, 403, { error: "Запрос с чужого сайта" });
      return true;
    }
    const form = await readForm(req);
    const ip = clientIp(req);

    if (url.pathname === "/api/logout") {
      json(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
      return true;
    }

    if (url.pathname === "/api/login") {
      if (!rateLimit(`login:${ip}`)) {
        json(res, 429, { error: "Слишком много попыток. Подождите 15 минут." });
        return true;
      }
      const viewer = login(form.get("login") ?? "", form.get("password") ?? "");
      if (!viewer) {
        json(res, 401, { error: "Неверный логин или пароль" });
        return true;
      }
      resetRateLimit(`login:${ip}`);
      audit(actorName(viewer), "вошёл(а) в кабинет");
      json(res, 200, { ok: true, role: viewer.role }, { "Set-Cookie": sessionCookie(createSession(viewer)) });
      return true;
    }

    if (url.pathname === "/api/invite") {
      if (!rateLimit(`invite:${ip}`)) {
        json(res, 429, { error: "Слишком много попыток. Подождите 15 минут." });
        return true;
      }
      try {
        const client = acceptInvite(form.get("token") ?? "", form.get("password") ?? "");
        audit(client.company, "открыл(а) кабинет по приглашению");
        await notifyOwner(`🔑 ${client.company} открыл(а) кабинет клиента.`);
        json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(createSession({ role: "client", client })) });
      } catch (error) {
        json(res, 400, { error: errorMessage(error) });
      }
      return true;
    }

    // Заявка с сайта
    if (!rateLimit(`lead:${ip}`, 5)) {
      json(res, 429, { error: "Слишком много заявок. Попробуйте позже или позвоните нам." });
      return true;
    }
    try {
      const lead = addLead({
        company: form.get("company"),
        name: form.get("name"),
        phone: form.get("phone"),
        plan: form.get("plan"),
        message: form.get("message"),
      });
      audit("Сайт", "новая заявка", lead.company, `${lead.name}, ${lead.phone}`);
      await notifyOwner(
        `📩 Заявка с сайта\n${lead.company} — ${lead.name}, ${lead.phone}${lead.plan ? `\nТариф: ${PLANS[lead.plan as keyof typeof PLANS]?.name ?? lead.plan}` : ""}${lead.message ? `\n${lead.message}` : ""}`,
      );
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 400, { error: errorMessage(error) });
    }
    return true;
  }

  return false;
}

async function handlePrivate(req: http.IncomingMessage, res: http.ServerResponse, url: URL, viewer: Viewer): Promise<void> {
  if (url.pathname === "/app" && req.method === "GET") {
    html(res, page(UI_FILE, viewer.role === "owner" ? "AI-студия" : `${viewer.client.company} — AI-студия`));
    return;
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    json(res, 200, buildStudioState({ viewer }));
    return;
  }

  const asset = /^\/assets\/([a-z0-9-]+)\/(characters|locations)\/([a-z0-9-]+)(?:\.(talk|blink))?\.png$/.exec(url.pathname);
  if (asset && req.method === "GET") {
    const [, slug, kind, id, variant] = asset as unknown as [string, string, AssetKind, string, CharacterVariant | undefined];
    if (viewer.role === "client" && viewer.client.brand !== slug) throw new HttpError(404, "not found");
    if (variant && kind !== "characters") throw new HttpError(404, "not found");
    const file = kind === "characters" ? characterAsset(slug, id, variant) : locationAsset(slug, id);
    if (!fs.existsSync(file)) throw new HttpError(404, "not found");
    sendFile(req, res, file, "private, max-age=86400");
    return;
  }

  const invoicePage = /^\/invoices\/(inv-[0-9a-f]{8})$/.exec(url.pathname);
  if (invoicePage && req.method === "GET") {
    const invoice = listInvoices().find((i) => i.id === invoicePage[1]);
    if (!invoice || (viewer.role === "client" && invoice.clientId !== viewer.client.id)) throw new HttpError(404, "Счёт не найден");
    const client = getClient(invoice.clientId);
    let title = client.brand;
    try {
      title = loadSeries(client.brand).title;
    } catch {
      // сериал удалён — в счёте будет его короткое имя
    }
    html(res, renderInvoicePage(invoice, client, title));
    return;
  }

  if (req.method !== "POST") throw new HttpError(404, "not found");
  if (!sameOrigin(req)) throw new HttpError(403, "Запрос с чужого сайта");

  const train = /^\/api\/brands\/([a-z0-9-]+)\/characters\/([a-z0-9-]+)\/train$/.exec(url.pathname);
  if (train) {
    ownerOnly(viewer);
    const [, slug, id] = train as unknown as [string, string, string];
    const ref = await trainCharacter(slug, id);
    background(`Обучение героя ${id}`, watchSoulTraining(slug, id));
    json(res, 202, { ok: true, status: ref.status });
    return;
  }

  const upload = /^\/api\/brands\/([a-z0-9-]+)\/(characters|locations)\/([a-z0-9-]+)$/.exec(url.pathname);
  if (upload) {
    ownerOnly(viewer);
    const [, slug, kind, id] = upload as unknown as [string, string, AssetKind, string];
    const series = loadSeries(slug);
    const known = kind === "characters" ? series.characters.some((c) => c.id === id) : series.locations.some((l) => l.id === id);
    if (!known) throw new HttpError(404, "Нет такого героя или места");
    const variantParam = url.searchParams.get("variant");
    if (variantParam && !isCharacterVariant(variantParam)) throw new HttpError(400, "Состояние героя: talk или blink");
    const variant = isCharacterVariant(variantParam) ? variantParam : undefined;
    const tmp = await readUpload(req);
    try {
      await saveAsset(slug, kind, id, tmp, variant);
    } finally {
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
    const what = variant === "talk" ? "рот героя" : variant === "blink" ? "моргание героя" : kind === "characters" ? "героя" : "локацию";
    audit("Студия", `загрузила ${what}`, slug, id);
    json(res, 200, { ok: true });
    return;
  }

  const form = await readForm(req);

  if (url.pathname === "/api/episodes") {
    if (viewer.role === "client") {
      const client = getClient(viewer.client.id);
      assertCanOrder(client);
      const brief = (form.get("brief") ?? "").trim();
      if (brief.length < 5) throw new HttpError(400, "Опишите задание: о чём серия, какая акция или повод");
      const ep = prepareEpisode(client.brand, { brief: brief.slice(0, 1000), orderedBy: client.company });
      audit(client.company, "заказал(а) серию", ep.id, brief.slice(0, 120));
      await notifyOwner(`📝 ${client.company} заказал(а) серию: «${brief.slice(0, 300)}»`);
      background("Серия клиента", runEpisode(ep.id));
      json(res, 202, { ok: true, id: ep.id });
      return;
    }
    const ep = prepareEpisode(form.get("series") || undefined, {
      brief: form.get("brief") ?? undefined,
      engine: form.get("engine") ?? undefined,
      orderedBy: "Студия",
    });
    background("Новая серия", runEpisode(ep.id));
    json(res, 202, { ok: true, id: ep.id });
    return;
  }

  const action = /^\/api\/episodes\/(ep-\d{8}-[0-9a-f]{8})\/(approve|reject|redo|run)$/.exec(url.pathname);
  if (action) {
    const id = action[1]!;
    const verb = action[2]!;
    if (viewer.role === "client") {
      if (verb !== "approve" && verb !== "redo") throw new HttpError(403, "Нет доступа");
      assertClientEpisode(viewer, id);
      const who = { by: "client" as const, clientId: viewer.client.id };
      if (verb === "approve") {
        background(`Одобрение клиентом ${id}`, approveEpisode(id, who));
        await notifyOwner(`✅ ${viewer.client.company} одобрил(а) серию ${id}.`);
      } else {
        const feedback = (form.get("feedback") ?? "").trim();
        if (!feedback) throw new HttpError(400, "Напишите, что поменять в серии");
        background(`Правки клиента ${id}`, redoEpisode(id, feedback.slice(0, 1000), "script", who));
        await notifyOwner(`✏️ ${viewer.client.company} просит правки в ${id}: «${feedback.slice(0, 300)}»`);
      }
      json(res, 202, { ok: true });
      return;
    }
    if (verb === "reject") {
      await rejectEpisode(id);
    } else if (verb === "approve") {
      background(`Одобрение ${id}`, approveEpisode(id));
    } else if (verb === "redo") {
      background(`Переделка ${id}`, redoEpisode(id, form.get("feedback") ?? ""));
    } else {
      background(`Продолжение ${id}`, runEpisode(id));
    }
    json(res, 202, { ok: true });
    return;
  }

  if (url.pathname === "/api/me/telegram") {
    if (viewer.role !== "client") throw new HttpError(403, "Нет доступа");
    const code = telegramLinkCode(viewer.client.id);
    const bot = await botUsername();
    json(res, 200, { ok: true, code, link: bot ? `https://t.me/${bot}?start=${code}` : undefined, bot });
    return;
  }

  if (url.pathname === "/api/me/password") {
    if (viewer.role !== "client") throw new HttpError(403, "Нет доступа");
    changePassword(viewer.client.id, form.get("current") ?? "", form.get("next") ?? "");
    const client = getClient(viewer.client.id);
    audit(client.company, "сменил(а) пароль");
    // Старые сессии с прежним паролем больше не действуют — выдаём новую этому браузеру.
    json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(createSession({ role: "client", client })) });
    return;
  }

  ownerOnly(viewer);

  if (url.pathname === "/api/brands") {
    const company = (form.get("company") ?? "").trim();
    const product = (form.get("product") ?? "").trim();
    const language = form.get("language") ?? "uz";
    if (!company || !product) throw new HttpError(400, "Укажи название компании и что она продаёт");
    if (language !== "uz" && language !== "ru" && language !== "en") throw new HttpError(400, "Язык сериала: uz, ru или en");
    background(
      `Бренд ${company}`,
      designBrandSeries({
        company,
        product,
        audience: (form.get("audience") ?? "").trim() || "Покупатели в Узбекистане, 18–45 лет",
        tone: (form.get("tone") ?? "").trim() || "Тёплый семейный юмор",
        language,
        wishes: (form.get("wishes") ?? "").trim() || undefined,
        contact: (form.get("contact") ?? "").trim() || undefined,
      }),
    );
    json(res, 202, { ok: true });
    return;
  }

  if (url.pathname === "/api/clients") {
    const client = createClient({
      brand: form.get("brand") ?? "",
      company: form.get("company") ?? undefined,
      contactName: form.get("contactName") ?? "",
      phone: form.get("phone") ?? undefined,
      email: form.get("email") ?? "",
      plan: form.get("plan") ?? "pilot",
      approval: form.get("approval") ?? undefined,
      periodStart: form.get("periodStart") || undefined,
    });
    audit("Студия", "добавила клиента", client.company, PLANS[client.plan].name);
    json(res, 200, { ok: true, id: client.id });
    return;
  }

  const clientAction = /^\/api\/clients\/(cl-[0-9a-f]{8})(?:\/(invite))?$/.exec(url.pathname);
  if (clientAction) {
    const id = clientAction[1]!;
    if (clientAction[2] === "invite") {
      const { token, expiresAt } = createInvite(id);
      const base = config.server.publicBaseUrl || `http://${req.headers.host ?? `localhost:${config.server.port}`}`;
      audit("Студия", "выдала приглашение", getClient(id).company);
      json(res, 200, { ok: true, url: `${base}/invite/${token}`, expiresAt });
      return;
    }
    const before = getClient(id);
    const client = updateClient(id, {
      plan: form.get("plan") ?? undefined,
      approval: form.get("approval") ?? undefined,
      status: form.get("status") ?? undefined,
      contactName: form.get("contactName") ?? undefined,
      phone: form.get("phone") ?? undefined,
      instagramUserId: form.get("instagramUserId") ?? undefined,
      instagramToken: form.get("instagramToken") ?? undefined,
      disconnectInstagram: form.get("disconnectInstagram") === "1",
      legalName: form.get("legalName") ?? undefined,
      legalInn: form.get("legalInn") ?? undefined,
      legalAddress: form.get("legalAddress") ?? undefined,
    });
    const changes = [
      before.plan !== client.plan && `тариф ${PLANS[client.plan].name}`,
      before.approval !== client.approval && "порядок согласования",
      before.status !== client.status && (client.status === "active" ? "возобновлён" : "пауза"),
      Boolean(before.instagram) !== Boolean(client.instagram) && (client.instagram ? "Instagram подключён" : "Instagram отключён"),
    ].filter(Boolean);
    if (changes.length) audit("Студия", "изменила клиента", client.company, changes.join(", "));
    json(res, 200, { ok: true });
    return;
  }

  const invoice = /^\/api\/invoices\/(inv-[0-9a-f]{8})\/paid$/.exec(url.pathname);
  if (invoice) {
    const paid = form.get("paid") !== "0";
    const inv = markInvoicePaid(invoice[1]!, paid);
    audit("Студия", paid ? "отметила оплату" : "сняла отметку об оплате", `счёт ${inv.number}`, `$${inv.amountUsd}`);
    json(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/daily") {
    background("Ежедневный цикл", dailyAll());
    json(res, 202, { ok: true });
    return;
  }

  throw new HttpError(404, "not found");
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (await handlePublic(req, res, url)) return;

  const viewer = viewerFrom(req);
  if (!viewer) {
    if (url.pathname.startsWith("/api/")) json(res, 401, { error: "Войдите заново", login: "/login" });
    else redirect(res, "/login");
    return;
  }

  try {
    await handlePrivate(req, res, url, viewer);
  } catch (error) {
    if (res.headersSent) throw error;
    json(res, error instanceof HttpError ? error.status : 400, { error: errorMessage(error) });
  }
}

export function startServer(): http.Server {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      log.error(`HTTP: ${errorMessage(error)}`);
      if (!res.headersSent) json(res, 500, { error: errorMessage(error) });
    });
  });
  if (config.server.production && !config.server.adminPassword) {
    log.warn("STUDIO_ADMIN_PASSWORD не задан — войти в панель студии нельзя (клиенты входят по своим паролям)");
  }
  server.listen(config.server.port, () => log.info(`Студия: http://localhost:${config.server.port} · кабинет: /app · вход: /login`));
  return server;
}

/** Текущее время в часовом поясе студии, HH:MM. */
export function localTime(date = new Date(), timeZone = config.schedule.timezone): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

/** Раз в минуту проверяет, не пора ли запустить ежедневный цикл. */
export function startScheduler(): NodeJS.Timeout | undefined {
  const at = config.schedule.dailyAt;
  if (!/^\d{2}:\d{2}$/.test(at)) {
    log.info("Расписание выключено (DAILY_AT не задан)");
    return undefined;
  }
  log.info(`Ежедневный запуск в ${at} (${config.schedule.timezone})`);
  let running = false;
  return setInterval(() => {
    if (running || localTime() < at || loadState().lastDailyRun === localDay()) return;
    running = true;
    // Отмечаем день сразу: если цикл упадёт, он не будет перезапускаться каждую минуту.
    saveState({ lastDailyRun: localDay() });
    dailyAll()
      .catch((e) => log.error(`Ежедневный цикл: ${errorMessage(e)}`))
      .finally(() => (running = false));
  }, 60_000);
}
