import crypto from "node:crypto";
import { localDay } from "./budget.js";
import { type IgAccount, studioInstagram } from "./integrations/instagram.js";
import { readCollection, writeCollection } from "./db.js";
import { PLANS, type PlanId, billingPeriods, currentPeriod, isPlan } from "./plans.js";
import { listEpisodes, loadSeries, seriesExists } from "./store.js";

/**
 * Клиенты студии — компании, которые купили сериал под свой бренд.
 * Хранятся в data/clients.json (права 600): там же хеш пароля и ключи Instagram клиента,
 * поэтому наружу (в интерфейс) отдаётся только publicClient().
 */

/** Кто согласует ролики перед публикацией. */
export const APPROVAL_MODES = ["studio_then_client", "client", "studio"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const APPROVAL_LABEL: Record<ApprovalMode, string> = {
  studio_then_client: "Студия, затем клиент",
  client: "Только клиент",
  studio: "Только студия",
};

export interface Client {
  id: string;
  /** Сериал бренда (series/<slug>.json). */
  brand: string;
  company: string;
  contactName: string;
  phone?: string;
  /** Логин в кабинет. */
  email: string;
  plan: PlanId;
  /** С какого дня считается тариф, YYYY-MM-DD. */
  periodStart: string;
  approval: ApprovalMode;
  status: "active" | "paused";
  passwordHash?: string;
  invite?: { tokenHash: string; expiresAt: string };
  telegram?: { chatId?: string; linkCode?: string; linkExpiresAt?: string };
  instagram?: { userId: string; token: string };
  createdAt: string;
}

export interface Invoice {
  id: string;
  number: string;
  clientId: string;
  plan: PlanId;
  periodStart: string;
  periodEnd: string;
  amountUsd: number;
  status: "unpaid" | "paid";
  issuedAt: string;
  paidAt?: string;
}

export interface Usage {
  periodStart: string;
  periodEnd: string;
  used: number;
  limit: number;
  left: number;
  /** Сколько дней осталось в периоде, включая сегодня. */
  daysLeft: number;
}

/** Что из карточки клиента можно показать в интерфейсе: без пароля, токенов и кодов. */
export interface PublicClient {
  id: string;
  brand: string;
  brandTitle: string;
  company: string;
  contactName: string;
  phone?: string;
  email: string;
  plan: PlanId;
  planName: string;
  priceUsd: number;
  periodStart: string;
  approval: ApprovalMode;
  approvalLabel: string;
  status: "active" | "paused";
  /** Принял ли клиент приглашение (задал пароль). */
  hasLogin: boolean;
  inviteActive: boolean;
  telegramLinked: boolean;
  instagramConnected: boolean;
  usage: Usage;
  unpaidUsd: number;
  createdAt: string;
}

const CLIENTS = "clients";
const INVOICES = "invoices";
const DAY_MS = 86_400_000;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
}

export function listClients(): Client[] {
  return readCollection<Client>(CLIENTS);
}

export function getClient(id: string): Client {
  const client = listClients().find((c) => c.id === id);
  if (!client) throw new Error(`Нет клиента ${id}`);
  return client;
}

export function clientForBrand(brand: string): Client | undefined {
  return listClients().find((c) => c.brand === brand);
}

export function clientByEmail(email: string): Client | undefined {
  const e = email.trim().toLowerCase();
  return listClients().find((c) => c.email === e);
}

function saveClient(client: Client): Client {
  const all = listClients();
  const i = all.findIndex((c) => c.id === client.id);
  if (i === -1) all.push(client);
  else all[i] = client;
  writeCollection(CLIENTS, all);
  return client;
}

function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Укажи почту клиента — это его логин в кабинет");
  return email;
}

export interface ClientInput {
  brand: string;
  company?: string;
  contactName: string;
  phone?: string;
  email: string;
  plan: string;
  approval?: string;
  periodStart?: string;
}

export function createClient(input: ClientInput): Client {
  if (!seriesExists(input.brand)) throw new Error(`Нет сериала «${input.brand}» — сначала создай бренд`);
  if (clientForBrand(input.brand)) throw new Error("У этого бренда уже есть клиент");
  if (!isPlan(input.plan)) throw new Error("Неизвестный тариф");
  const approval = input.approval ?? "studio_then_client";
  if (!(APPROVAL_MODES as readonly string[]).includes(approval)) throw new Error("Неизвестный порядок согласования");
  const email = normalizeEmail(input.email);
  if (clientByEmail(email)) throw new Error("Клиент с такой почтой уже есть");
  if (!input.contactName.trim()) throw new Error("Укажи контактное лицо");
  const periodStart = input.periodStart || localDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) throw new Error("Дата старта: ГГГГ-ММ-ДД");

  const series = loadSeries(input.brand);
  return saveClient({
    id: randomId("cl"),
    brand: input.brand,
    company: input.company?.trim() || series.client?.company || series.title,
    contactName: input.contactName.trim(),
    phone: input.phone?.trim() || undefined,
    email,
    plan: input.plan,
    periodStart,
    approval: approval as ApprovalMode,
    status: "active",
    createdAt: new Date().toISOString(),
  });
}

export interface ClientPatch {
  plan?: string;
  approval?: string;
  status?: string;
  contactName?: string;
  phone?: string;
  instagramUserId?: string;
  instagramToken?: string;
  disconnectInstagram?: boolean;
}

export function updateClient(id: string, patch: ClientPatch): Client {
  const client = getClient(id);
  if (patch.plan !== undefined) {
    if (!isPlan(patch.plan)) throw new Error("Неизвестный тариф");
    client.plan = patch.plan;
  }
  if (patch.approval !== undefined) {
    if (!(APPROVAL_MODES as readonly string[]).includes(patch.approval)) throw new Error("Неизвестный порядок согласования");
    client.approval = patch.approval as ApprovalMode;
  }
  if (patch.status !== undefined) {
    if (patch.status !== "active" && patch.status !== "paused") throw new Error("Статус: active или paused");
    client.status = patch.status;
  }
  if (patch.contactName?.trim()) client.contactName = patch.contactName.trim();
  if (patch.phone !== undefined) client.phone = patch.phone.trim() || undefined;
  if (patch.disconnectInstagram) delete client.instagram;
  if (patch.instagramUserId?.trim() && patch.instagramToken?.trim()) {
    client.instagram = { userId: patch.instagramUserId.trim(), token: patch.instagramToken.trim() };
  }
  return saveClient(client);
}

// ---------- Приглашение и пароль ----------

const INVITE_DAYS = 7;

/** Новое приглашение в кабинет. Сам токен возвращается один раз и в файл не пишется — только хеш. */
export function createInvite(id: string): { token: string; expiresAt: string } {
  const client = getClient(id);
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_DAYS * DAY_MS).toISOString();
  client.invite = { tokenHash: sha256(token), expiresAt };
  saveClient(client);
  return { token, expiresAt };
}

export function clientByInvite(token: string): Client | undefined {
  if (!token) return undefined;
  const hash = sha256(token);
  return listClients().find((c) => c.invite && c.invite.tokenHash === hash && c.invite.expiresAt > new Date().toISOString());
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  const [kind, salt, hash] = (stored ?? "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64url"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function checkPasswordStrength(password: string): void {
  if (password.length < 8) throw new Error("Пароль — минимум 8 символов");
  if (password.length > 200) throw new Error("Слишком длинный пароль");
}

/** Клиент задаёт пароль по ссылке-приглашению. Ссылка после этого больше не работает. */
export function acceptInvite(token: string, password: string): Client {
  const client = clientByInvite(token);
  if (!client) throw new Error("Ссылка устарела или уже использована — попросите студию прислать новую");
  checkPasswordStrength(password);
  client.passwordHash = hashPassword(password);
  delete client.invite;
  return saveClient(client);
}

export function verifyClientLogin(email: string, password: string): Client | undefined {
  const client = clientByEmail(email);
  // Даже если клиента нет, считаем хеш: время ответа не выдаёт, есть ли такая почта.
  const ok = verifyPassword(password, client?.passwordHash ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  return client && ok ? client : undefined;
}

export function changePassword(id: string, current: string, next: string): void {
  const client = getClient(id);
  if (!verifyPassword(current, client.passwordHash)) throw new Error("Текущий пароль неверный");
  checkPasswordStrength(next);
  client.passwordHash = hashPassword(next);
  saveClient(client);
}

// ---------- Telegram клиента ----------

/** Одноразовый код: клиент отправляет боту /start КОД, и чат привязывается к кабинету. */
export function telegramLinkCode(id: string): string {
  const client = getClient(id);
  const code = crypto.randomBytes(4).toString("hex").toUpperCase();
  client.telegram = { ...client.telegram, linkCode: code, linkExpiresAt: new Date(Date.now() + DAY_MS).toISOString() };
  saveClient(client);
  return code;
}

export function linkTelegram(code: string, chatId: string): Client | undefined {
  const c = code.trim().toUpperCase();
  if (!/^[0-9A-F]{8}$/.test(c)) return undefined;
  const now = new Date().toISOString();
  const client = listClients().find((x) => x.telegram?.linkCode === c && (x.telegram.linkExpiresAt ?? "") > now);
  if (!client) return undefined;
  client.telegram = { chatId };
  return saveClient(client);
}

export function clientByChat(chatId: string | number): Client | undefined {
  const id = String(chatId);
  return listClients().find((c) => c.telegram?.chatId === id);
}

// ---------- Тариф, расход серий, счета ----------

/** Серии бренда, которые засчитываются в тариф: всё, кроме отклонённых студией и упавших. */
export function usage(client: Client, today = localDay()): Usage {
  const plan = PLANS[client.plan];
  const period = currentPeriod(plan, client.periodStart, today);
  const used = listEpisodes().filter((e) => {
    if (e.series !== client.brand || e.status === "rejected" || e.status === "failed") return false;
    const day = localDay(new Date(e.createdAt));
    return day >= period.start && day < period.end;
  }).length;
  const daysLeft = Math.max(1, Math.round((Date.parse(`${period.end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS));
  return { periodStart: period.start, periodEnd: period.end, used, limit: plan.episodes, left: Math.max(0, plan.episodes - used), daysLeft };
}

/** Можно ли сейчас заказать серию: клиент активен, период тарифа не закончился, серии остались. */
export function assertCanOrder(client: Client, today = localDay()): void {
  if (client.status !== "active") throw new Error("Подписка на паузе — напишите студии, чтобы продолжить");
  const u = usage(client, today);
  if (today >= u.periodEnd) throw new Error("Пилотный период закончился — выберите тариф, чтобы продолжить");
  if (u.left <= 0) throw new Error(`Серии по тарифу на этот период закончились (${u.used} из ${u.limit}). Новый период — с ${u.periodEnd}`);
}

/**
 * Сколько серий автопилот должен сделать сегодня, чтобы серии шли ровно по всему периоду:
 * к концу дня должно быть сделано limit × (прошедшие дни / дни периода). Не больше 2 в день.
 */
export function autopilotDue(client: Client, today = localDay()): number {
  if (client.status !== "active") return 0;
  const u = usage(client, today);
  if (today >= u.periodEnd || u.left <= 0) return 0;
  const total = Math.round((Date.parse(`${u.periodEnd}T00:00:00Z`) - Date.parse(`${u.periodStart}T00:00:00Z`)) / DAY_MS);
  const elapsed = total - u.daysLeft + 1;
  const expected = Math.ceil((u.limit * elapsed) / total);
  return Math.max(0, Math.min(2, expected - u.used, u.left));
}

export function listInvoices(clientId?: string): Invoice[] {
  const all = readCollection<Invoice>(INVOICES);
  return (clientId ? all.filter((i) => i.clientId === clientId) : all).sort((a, b) => b.periodStart.localeCompare(a.periodStart));
}

/** Выставляет счета за все периоды тарифа до сегодняшнего включительно, которых ещё нет. */
export function ensureInvoices(today = localDay()): Invoice[] {
  const all = readCollection<Invoice>(INVOICES);
  let changed = false;
  for (const client of listClients()) {
    // На паузе новые счета не выставляются.
    if (client.status !== "active") continue;
    const plan = PLANS[client.plan];
    for (const period of billingPeriods(plan, client.periodStart, today)) {
      if (all.some((i) => i.clientId === client.id && i.periodStart === period.start)) continue;
      const year = period.start.slice(0, 4);
      const seq = all.filter((i) => i.number.startsWith(`${year}-`)).length + 1;
      all.push({
        id: randomId("inv"),
        number: `${year}-${String(seq).padStart(4, "0")}`,
        clientId: client.id,
        plan: client.plan,
        periodStart: period.start,
        periodEnd: period.end,
        amountUsd: plan.priceUsd,
        status: "unpaid",
        issuedAt: new Date().toISOString(),
      });
      changed = true;
    }
  }
  if (changed) writeCollection(INVOICES, all);
  return all;
}

export function markInvoicePaid(id: string, paid = true): Invoice {
  const all = readCollection<Invoice>(INVOICES);
  const inv = all.find((i) => i.id === id);
  if (!inv) throw new Error(`Нет счёта ${id}`);
  inv.status = paid ? "paid" : "unpaid";
  if (paid) inv.paidAt = new Date().toISOString();
  else delete inv.paidAt;
  writeCollection(INVOICES, all);
  return inv;
}

export function publicClient(client: Client, today = localDay()): PublicClient {
  const plan = PLANS[client.plan];
  let brandTitle = client.brand;
  try {
    brandTitle = loadSeries(client.brand).title;
  } catch {
    // сериал удалён вручную — показываем slug
  }
  return {
    id: client.id,
    brand: client.brand,
    brandTitle,
    company: client.company,
    contactName: client.contactName,
    phone: client.phone,
    email: client.email,
    plan: client.plan,
    planName: plan.name,
    priceUsd: plan.priceUsd,
    periodStart: client.periodStart,
    approval: client.approval,
    approvalLabel: APPROVAL_LABEL[client.approval],
    status: client.status,
    hasLogin: Boolean(client.passwordHash),
    inviteActive: Boolean(client.invite && client.invite.expiresAt > new Date().toISOString()),
    telegramLinked: Boolean(client.telegram?.chatId),
    instagramConnected: Boolean(client.instagram),
    usage: usage(client, today),
    unpaidUsd: listInvoices(client.id)
      .filter((i) => i.status === "unpaid")
      .reduce((sum, i) => sum + i.amountUsd, 0),
    createdAt: client.createdAt,
  };
}

/**
 * Куда публиковать сериал: бренд клиента — только в Instagram клиента (никогда не в аккаунт студии),
 * собственный сериал студии — в аккаунт студии.
 */
export function instagramFor(brand: string): IgAccount | undefined {
  const client = clientForBrand(brand);
  if (client) return client.instagram;
  return studioInstagram();
}
