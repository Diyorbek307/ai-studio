import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { budgetSummary, localDay } from "./budget.js";
import { config, describeProviders } from "./config.js";
import { errorMessage, log } from "./log.js";
import { approveEpisode, dailyJob, newEpisode, redoEpisode, rejectEpisode, runEpisode } from "./pipeline.js";
import { episodeDir, loadState, saveState } from "./store.js";
import { buildStudioState } from "./studioState.js";

/** Интерфейс студии — один HTML-файл в ui/ (от dist/src/ это ../../ui). */
export const UI_FILE = fileURLToPath(new URL("../../ui/app.html", import.meta.url));

/** Обёртка документа вокруг ui/app.html (сам файл — фрагмент, его же публикуем как превью). */
export function renderAppPage(fragment: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
${fragment}
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
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(body));
}

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 20_000) throw new Error("Слишком большой запрос");
  }
  return new URLSearchParams(body);
}

/** Запускает долгую задачу в фоне: интерфейс сразу получает ответ, а ход работы видит через /api/state. */
function background(label: string, task: Promise<unknown>): void {
  task.catch((e) => log.error(`${label}: ${errorMessage(e)}`));
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
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="ai-studio", charset="UTF-8"' }).end();
    }
    return;
  }

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(
      renderAppPage(fs.readFileSync(UI_FILE, "utf8")),
    );
    return;
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    json(res, 200, buildStudioState());
    return;
  }

  if (url.pathname === "/api/episodes" && req.method === "POST") {
    background("Новая серия", newEpisode());
    json(res, 202, { ok: true });
    return;
  }

  const action = /^\/api\/episodes\/(ep-\d{8}-[0-9a-f]{8})\/(approve|reject|redo|run)$/.exec(url.pathname);
  if (action && req.method === "POST") {
    const id = action[1]!;
    const verb = action[2]!;
    const form = await readForm(req);
    try {
      if (verb === "reject") {
        await rejectEpisode(id);
      } else if (verb === "approve") {
        background(`Публикация ${id}`, approveEpisode(id));
      } else if (verb === "redo") {
        background(`Переделка ${id}`, redoEpisode(id, form.get("feedback") ?? ""));
      } else {
        background(`Продолжение ${id}`, runEpisode(id));
      }
      json(res, 202, { ok: true });
    } catch (error) {
      json(res, 400, { error: errorMessage(error) });
    }
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
  server.listen(config.server.port, () => log.info(`Студия: http://localhost:${config.server.port}`));
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
