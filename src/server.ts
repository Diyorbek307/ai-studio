import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { budgetSummary, localDay } from "./budget.js";
import { config, describeProviders } from "./config.js";
import { errorMessage, log } from "./log.js";
import { approveEpisode, dailyJob, newEpisode, redoEpisode, rejectEpisode } from "./pipeline.js";
import { episodeDir, listEpisodes, loadState, saveState } from "./store.js";
import { type Episode, STATUS_LABEL } from "./types.js";

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

function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string): void {
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
    });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
  fs.createReadStream(file).pipe(res);
}

function authorized(req: http.IncomingMessage): boolean {
  if (!config.server.adminPassword) return !config.server.production;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const [user, pass] = Buffer.from(header.slice(6), "base64").toString().split(":");
  return user === "admin" && pass === config.server.adminPassword;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 20_000) throw new Error("Слишком большой запрос");
  }
  return new URLSearchParams(body);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function episodeCard(ep: Episode): string {
  const poster = ep.keyframes?.s1 ? ` poster="/media/${ep.id}/${ep.keyframes.s1}"` : "";
  const video = ep.final ? `<video src="/media/${ep.id}/${ep.final}"${poster} controls preload="none" playsinline></video>` : "";
  const lines = (ep.script?.scenes ?? [])
    .flatMap((s) => s.lines)
    .map((l) => `<li><b>${escapeHtml(l.character)}</b>: ${escapeHtml(l.text)}<br><small>${escapeHtml(l.translation_ru)}</small></li>`)
    .join("");
  const canDecide = ep.status === "awaiting_approval" || ep.status === "awaiting_feedback";
  const actions = canDecide
    ? `<form method="post" action="/api/episodes/${ep.id}/approve"><button>✅ Одобрить</button></form>
       <form method="post" action="/api/episodes/${ep.id}/redo"><input name="feedback" placeholder="Что исправить"><button>🔁 Переделать</button></form>
       <form method="post" action="/api/episodes/${ep.id}/reject"><button>🗑 Отклонить</button></form>`
    : "";
  return `<article>
    <header><h2>${escapeHtml(ep.script?.title ?? ep.id)}</h2><span class="st">${STATUS_LABEL[ep.status]}</span></header>
    <p class="meta">${ep.id} · ${ep.createdAt.slice(0, 16).replace("T", " ")} · $${ep.costUsd.toFixed(2)}${ep.step ? ` · шаг: ${ep.step}` : ""}</p>
    ${ep.error ? `<p class="err">${escapeHtml(ep.error)}</p>` : ""}
    ${ep.qa ? `<p>${ep.qa.pass ? "✅" : "⚠️"} ${escapeHtml(ep.qa.review.summary_ru)}</p>` : ""}
    ${video}
    ${lines ? `<details><summary>Сценарий</summary><ul>${lines}</ul></details>` : ""}
    ${ep.publish?.permalink ? `<p><a href="${escapeHtml(ep.publish.permalink)}">Открыть в Instagram</a></p>` : ""}
    <div class="actions">${actions}</div>
  </article>`;
}

function dashboard(): string {
  const cards = listEpisodes().slice(0, 30).map(episodeCard).join("");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI-студия</title><style>
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e2e0da;--accent:#2f7d4f}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#22221f;--ink:#efeee9;--muted:#a3a29b;--line:#383732;--accent:#5fbf86}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:8px 0}.meta,small{color:var(--muted)}
article{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:14px 0}
article header{display:flex;justify-content:space-between;gap:8px;align-items:baseline}h2{font-size:17px;margin:0}
.st{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);white-space:nowrap}
video{width:100%;max-width:300px;aspect-ratio:9/16;background:#000;border-radius:8px;display:block;margin:8px 0}
.actions{display:flex;flex-wrap:wrap;gap:8px}.actions form{display:flex;gap:6px}
button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:7px 12px;font:inherit;cursor:pointer}
input{border:1px solid var(--line);border-radius:6px;padding:6px;background:var(--bg);color:var(--ink);min-width:0}
.err{color:#c0392b}ul{padding-left:18px}
</style></head><body><main>
<h1>🎬 AI-студия</h1>
<p class="meta">${escapeHtml(describeProviders())}<br>${escapeHtml(budgetSummary())}</p>
<form method="post" action="/api/episodes"><button>➕ Новая серия</button></form>
${cards || "<p>Эпизодов пока нет.</p>"}
</main></body></html>`;
}

function redirectHome(res: http.ServerResponse): void {
  res.writeHead(303, { Location: "/" }).end();
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/health") {
    json(res, 200, { ok: true, providers: describeProviders(), budget: budgetSummary() });
    return;
  }

  const media = /^\/media\/(ep-\d{8}-[0-9a-f]{8})\/(.+)$/.exec(url.pathname);
  if (media && req.method === "GET") {
    const file = publicMediaPath(media[1]!, media[2]!);
    if (!file) json(res, 404, { error: "not found" });
    else sendFile(req, res, file);
    return;
  }

  if (!authorized(req)) {
    if (!config.server.adminPassword && config.server.production) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("Задай STUDIO_ADMIN_PASSWORD, чтобы открыть панель.");
    } else {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="ai-studio"' }).end();
    }
    return;
  }

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(dashboard());
    return;
  }

  if (url.pathname === "/api/episodes" && req.method === "POST") {
    newEpisode().catch((e) => log.error(`Новая серия: ${errorMessage(e)}`));
    redirectHome(res);
    return;
  }

  const action = /^\/api\/episodes\/(ep-\d{8}-[0-9a-f]{8})\/(approve|reject|redo)$/.exec(url.pathname);
  if (action && req.method === "POST") {
    const id = action[1]!;
    const verb = action[2]!;
    const form = await readForm(req);
    const task =
      verb === "approve" ? approveEpisode(id) : verb === "reject" ? rejectEpisode(id) : redoEpisode(id, form.get("feedback") ?? "");
    task.catch((e) => log.error(`${verb} ${id}: ${errorMessage(e)}`));
    redirectHome(res);
    return;
  }

  json(res, 404, { error: "not found" });
}

export function startServer(): http.Server {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      log.error(`HTTP: ${errorMessage(error)}`);
      if (!res.headersSent) json(res, 500, { error: errorMessage(error) });
    });
  });
  server.listen(config.server.port, () => log.info(`Сервер: http://localhost:${config.server.port}`));
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
    dailyJob()
      .catch((e) => log.error(`Ежедневный цикл: ${errorMessage(e)}`))
      .finally(() => (running = false));
  }, 60_000);
}
