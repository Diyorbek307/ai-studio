import { appendLine, readLines } from "./db.js";

export interface AuditEntry {
  ts: string;
  /** Кто сделал: "Студия", название компании клиента или "Система". */
  actor: string;
  action: string;
  target?: string;
  detail?: string;
}

/** Журнал действий: кто что одобрил, отклонил, оплатил, кого пригласил. */
export function audit(actor: string, action: string, target?: string, detail?: string): void {
  appendLine("audit", { ts: new Date().toISOString(), actor, action, target, detail } satisfies AuditEntry);
}

export function recentAudit(limit = 60): AuditEntry[] {
  return readLines<AuditEntry>("audit", limit);
}
