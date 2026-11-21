import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { type Client, getClient, verifyClientLogin } from "./clients.js";
import { config } from "./config.js";
import { getMember, type TeamMember, verifyMemberLogin } from "./team.js";

/**
 * Вход в студию.
 * Владелец студии: логин admin + STUDIO_ADMIN_PASSWORD (а для скриптов — тот же пароль через Basic).
 * Клиент: почта + пароль, который он сам задал по ссылке-приглашению.
 * Сессия — подписанная HMAC cookie (HttpOnly, SameSite=Lax), на сервере ничего не хранится.
 */

export type Viewer = { role: "owner" } | { role: "operator"; member: TeamMember } | { role: "client"; client: Client };

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
  r: "owner" | "operator" | "client";
  c?: string;
  /** Срок, мс с 1970. */
  e: number;
  /** Отпечаток пароля клиента: смена пароля выкидывает старые сессии. */
  p?: string;
}

function stamp(secretValue: string): string {
  return crypto.createHash("sha256").update(secretValue).digest("base64url").slice(0, 12);
}

function passwordStamp(client: Client): string {
  return stamp(client.passwordHash ?? "");
}

/** Отпечаток пароля владельца: при смене STUDIO_ADMIN_PASSWORD старые сессии владельца перестают действовать. */
function ownerStamp(): string {
  return stamp(`owner:${config.server.adminPassword}`);
}

export function createSession(viewer: Viewer): string {
  const payload: SessionPayload = {
    r: viewer.role,
    e: Date.now() + SESSION_DAYS * 86_400_000,
    ...(viewer.role === "client"
      ? { c: viewer.client.id, p: passwordStamp(viewer.client) }
      : viewer.role === "operator"
        ? { c: viewer.member.id, p: stamp(viewer.member.passwordHash ?? "") }
        : { p: ownerStamp() }),
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
  if (payload.r === "owner") return payload.p === ownerStamp() ? { role: "owner" } : undefined;
  if (payload.r === "operator" && payload.c) {
    try {
      const member = getMember(payload.c);
      // Отключённый сотрудник или сменённый пароль — сессия больше не действует.
      if (member.status !== "active" || !member.passwordHash || stamp(member.passwordHash) !== payload.p) return undefined;
      return { role: "operator", member };
    } catch {
      return undefined;
    }
  }
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

/**
 * Без пароля владельца студия открыта только для разработки: не в production
 * и только для запросов с этого же компьютера (не через прокси и не из локальной сети).
 */
export function devOpen(req?: http.IncomingMessage): boolean {
  if (config.server.adminPassword || config.server.production) return false;
  if (!req) return true;
  if (req.headers["x-forwarded-for"]) return false;
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
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
  if (devOpen(req)) return { role: "owner" };
  return undefined;
}

/** Проверка логина: admin — владелец, почта — клиент. */
export function login(loginName: string, password: string): Viewer | undefined {
  const name = loginName.trim();
  if (name.toLowerCase() === "admin") return ownerPasswordOk(password) ? { role: "owner" } : undefined;
  const client = verifyClientLogin(name, password);
  if (client) return { role: "client", client };
  const member = verifyMemberLogin(name, password);
  return member ? { role: "operator", member } : undefined;
}

// ---------- Защита от перебора ----------

const attempts = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;

export function clientIp(req: http.IncomingMessage): string {
  // За прокси (Render) адрес клиента дописывается в конец X-Forwarded-For; начало списка клиент может подделать.
  const forwarded = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .at(-1);
  return forwarded || req.socket.remoteAddress || "?";
}

/** true — можно пробовать; false — слишком много попыток с этого адреса, подождать 15 минут. */
export function rateLimit(key: string, max = MAX_ATTEMPTS): boolean {
  const now = Date.now();
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
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
