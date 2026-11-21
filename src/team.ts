import crypto from "node:crypto";
import { checkPasswordStrength, clientByEmail, hashPassword, verifyPassword } from "./clients.js";
import { readCollection, writeCollection } from "./db.js";

/**
 * Команда студии: операторы, которые ведут серии вместо владельца — делают и одобряют серии,
 * загружают картинки героев, настраивают бренды. Деньги, клиенты, счета, аналитика и настройки им не видны.
 * Хранится в data/team.json (права 600); вход — по почте и паролю, заданному по приглашению.
 */
export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: "operator";
  status: "active" | "disabled";
  passwordHash?: string;
  invite?: { tokenHash: string; expiresAt: string };
  createdAt: string;
}

export interface PublicMember {
  id: string;
  name: string;
  email: string;
  status: "active" | "disabled";
  hasLogin: boolean;
  inviteActive: boolean;
}

const TEAM = "team";
const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

export function listTeam(): TeamMember[] {
  return readCollection<TeamMember>(TEAM);
}

export function getMember(id: string): TeamMember {
  const m = listTeam().find((x) => x.id === id);
  if (!m) throw new Error(`Нет сотрудника ${id}`);
  return m;
}

function save(member: TeamMember): TeamMember {
  const all = listTeam();
  const i = all.findIndex((x) => x.id === member.id);
  if (i === -1) all.push(member);
  else all[i] = member;
  writeCollection(TEAM, all);
  return member;
}

export function memberByEmail(email: string): TeamMember | undefined {
  const e = email.trim().toLowerCase();
  return listTeam().find((m) => m.email === e);
}

export function createMember(input: { name: string; email: string }): TeamMember {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name) throw new Error("Укажите имя сотрудника");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Укажите почту сотрудника — это его логин");
  if (memberByEmail(email) || clientByEmail(email)) throw new Error("Эта почта уже используется для входа");
  return save({ id: `tm-${crypto.randomBytes(4).toString("hex")}`, name: name.slice(0, 80), email, role: "operator", status: "active", createdAt: new Date().toISOString() });
}

export function setMemberStatus(id: string, status: string): TeamMember {
  if (status !== "active" && status !== "disabled") throw new Error("Статус: active или disabled");
  const m = getMember(id);
  m.status = status;
  return save(m);
}

/** Приглашение на 7 дней; токен возвращается один раз, хранится только хеш. */
export function createMemberInvite(id: string): { token: string; expiresAt: string } {
  const m = getMember(id);
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  m.invite = { tokenHash: sha256(token), expiresAt };
  save(m);
  return { token, expiresAt };
}

export function memberByInvite(token: string): TeamMember | undefined {
  if (!token) return undefined;
  const hash = sha256(token);
  return listTeam().find((m) => m.status === "active" && m.invite?.tokenHash === hash && m.invite.expiresAt > new Date().toISOString());
}

export function acceptMemberInvite(token: string, password: string): TeamMember {
  const m = memberByInvite(token);
  if (!m) throw new Error("Ссылка устарела или уже использована — попросите владельца студии прислать новую");
  checkPasswordStrength(password);
  m.passwordHash = hashPassword(password);
  delete m.invite;
  return save(m);
}

export function verifyMemberLogin(email: string, password: string): TeamMember | undefined {
  const m = memberByEmail(email);
  const ok = verifyPassword(password, m?.passwordHash ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  return m && ok && m.status === "active" ? m : undefined;
}

export function changeMemberPassword(id: string, current: string, next: string): void {
  const m = getMember(id);
  if (!verifyPassword(current, m.passwordHash)) throw new Error("Текущий пароль неверный");
  checkPasswordStrength(next);
  m.passwordHash = hashPassword(next);
  save(m);
}

export function publicMember(m: TeamMember): PublicMember {
  return {
    id: m.id,
    name: m.name,
    email: m.email,
    status: m.status,
    hasLogin: Boolean(m.passwordHash),
    inviteActive: Boolean(m.invite && m.invite.expiresAt > new Date().toISOString()),
  };
}
