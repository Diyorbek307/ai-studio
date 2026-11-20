import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { type Client, getClient, verifyClientLogin } from "./clients.js";
import { config } from "./config.js";

/**
 * Вход в студию.
 * Владелец студии: логин admin + STUDIO_ADMIN_PASSWORD (а для скриптов — тот же пароль через Basic).
 * Клиент: почта + пароль, который он сам задал по ссылке-приглашению.
 * Сессия — подписанная HMAC cookie (HttpOnly, SameSite=Lax), на сервере ничего не хранится.
 */

export type Viewer = { role: "owner" } | { role: "client"; client: Client };

export const SESSION_COOKIE = "studio_session";
const SESSION_DAYS = 30;

let cachedSecret: Buffer | undefined;

/** Ключ подписи: STUDIO_SESSION_SECRET или случайный, сохранённый в data/.session-secret. */
function secret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const fromEnv = (process.env.STUDIO_SESSION_SECRET ?? "").trim();
  if (fromEnv.length >= 32) return (cachedSecret = Buffer.from(fromEnv));
  const file = path.join(config.dataDir, ".session-secret");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(48).toString("base64url"), { mode: 0o600 });
  }
  return (cachedSecret = Buffer.from(fs.readFileSync(file, "utf8").trim()));
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

interface SessionPayload {
  r: "owner" | "client";
  c?: string;
  /** Срок, мс с 1970. */
  e: number;
  /** Отпечаток пароля клиента: смена пароля выкидывает старые сессии. */
  p?: string;
}

function passwordStamp(client: Client): string {
  return crypto.createHash("sha256").update(client.passwordHash ?? "").digest("base64url").slice(0, 12);
}

export function createSession(viewer: Viewer): string {
  const payload: SessionPayload = {
    r: viewer.role,
    e: Date.now() + SESSION_DAYS * 86_400_000,
    ...(viewer.role === "client" ? { c: viewer.client.id, p: passwordStamp(viewer.client) } : {}),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function readSession(token: string | undefined): Viewer | undefined {
  if (!token) return undefined;
  const [body, sig] = token.split(".");
  if (!body || !sig) return undefined;
  const expected = Buffer.from(sign(body));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return undefined;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
  } catch {
    return undefined;
  }
  if (!payload.e || payload.e < Date.now()) return undefined;
  if (payload.r === "owner") return { role: "owner" };
  if (payload.r === "client" && payload.c) {
    try {
      const client = getClient(payload.c);
      if (!client.passwordHash || passwordStamp(client) !== payload.p) return undefined;
      return { role: "client", client };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string): string {
  const secure = config.server.production || config.server.publicBaseUrl.startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function ownerPasswordOk(password: string): boolean {
  const expected = config.server.adminPassword;
  if (!expected) return false;
  const a = crypto.createHash("sha256").update(password).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Без пароля владельца студия открыта только локально (не в production) — для разработки. */
export function devOpen(): boolean {
  return !config.server.adminPassword && !config.server.production;
}

/** Кто сделал запрос: по cookie, по Basic (для скриптов владельца) или локальная разработка. */
export function viewerFrom(req: http.IncomingMessage): Viewer | undefined {
  const session = readSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (session) return session;
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Basic ")) {
    const raw = Buffer.from(header.slice(6), "base64").toString();
    const i = raw.indexOf(":");
    if (i > 0 && raw.slice(0, i) === "admin" && ownerPasswordOk(raw.slice(i + 1))) return { role: "owner" };
  }
  if (devOpen()) return { role: "owner" };
  return undefined;
}

/** Проверка логина: admin — владелец, почта — клиент. */
export function login(loginName: string, password: string): Viewer | undefined {
  const name = loginName.trim();
  if (name.toLowerCase() === "admin") return ownerPasswordOk(password) ? { role: "owner" } : undefined;
  const client = verifyClientLogin(name, password);
  return client ? { role: "client", client } : undefined;
}

// ---------- Защита от перебора ----------

const attempts = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;

export function clientIp(req: http.IncomingMessage): string {
  // За прокси (Render) настоящий адрес — первый в X-Forwarded-For.
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
  return forwarded || req.socket.remoteAddress || "?";
}

/** true — можно пробовать; false — слишком много попыток с этого адреса, подождать 15 минут. */
export function rateLimit(key: string, max = MAX_ATTEMPTS): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.until < now) {
    attempts.set(key, { count: 1, until: now + WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= max;
}

export function resetRateLimit(key: string): void {
  attempts.delete(key);
}

/**
 * Защита от подделки запросов с чужих сайтов: POST принимаем только со своей страницы.
 * Браузер всегда шлёт Origin у POST из fetch/форм; у curl и скриптов его нет — их пропускаем.
 */
export function sameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).host;
    const forwardedHost = String(req.headers["x-forwarded-host"] ?? "").split(",")[0]?.trim();
    return host === req.headers.host || (forwardedHost !== "" && host === forwardedHost);
  } catch {
    return false;
  }
}
