import { appendLine, readLines } from "./db.js";

/** Заявка с сайта студии: компания хочет свой сериал. */
export interface Lead {
  ts: string;
  company: string;
  name: string;
  phone: string;
  plan?: string;
  message?: string;
}

function field(value: string | null | undefined, max: number): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function addLead(input: { company?: string | null; name?: string | null; phone?: string | null; plan?: string | null; message?: string | null }): Lead {
  const lead: Lead = {
    ts: new Date().toISOString(),
    company: field(input.company, 120),
    name: field(input.name, 80),
    phone: field(input.phone, 40),
    plan: field(input.plan, 20) || undefined,
    message: field(input.message, 1000) || undefined,
  };
  if (!lead.company || !lead.name) throw new Error("Укажите компанию и имя");
  if (!/^[+\d][\d\s()-]{6,}$/.test(lead.phone)) throw new Error("Укажите телефон, например +998 90 123 45 67");
  appendLine("leads", lead);
  return lead;
}

export function listLeads(limit = 100): Lead[] {
  return readLines<Lead>("leads", limit);
}
