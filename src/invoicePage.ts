import { type Client, type Invoice } from "./clients.js";
import { config } from "./config.js";
import { PLANS } from "./plans.js";

/**
 * Счёт на оплату — отдельная страница для печати или сохранения в PDF.
 * Реквизиты студии берутся из настроек (STUDIO_LEGAL_NAME, STUDIO_INN…), реквизиты клиента — из его карточки.
 */

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function day(iso: string, shift = 0): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  d.setUTCDate(d.getUTCDate() + shift);
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function money(n: number, currency: "USD" | "UZS"): string {
  const value = n.toLocaleString("ru-RU", { minimumFractionDigits: currency === "USD" ? 2 : 0, maximumFractionDigits: currency === "USD" ? 2 : 0 });
  return currency === "USD" ? `${value} USD` : `${value} сум`;
}

/** Сумма прописью для суммы в сумах или долларах (целая часть). */
export function amountInWords(n: number, currency: "USD" | "UZS"): string {
  const ones = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
  const onesF = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
  const teens = ["десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"];
  const tens = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
  const hundreds = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];
  const form = (x: number, f: [string, string, string]) => {
    const m10 = x % 10, m100 = x % 100;
    if (m100 >= 11 && m100 <= 14) return f[2];
    if (m10 === 1) return f[0];
    if (m10 >= 2 && m10 <= 4) return f[1];
    return f[2];
  };
  const triple = (x: number, feminine: boolean): string[] => {
    const out = [hundreds[Math.floor(x / 100)]!];
    const r = x % 100;
    if (r >= 10 && r < 20) out.push(teens[r - 10]!);
    else out.push(tens[Math.floor(r / 10)]!, (feminine ? onesF : ones)[r % 10]!);
    return out.filter(Boolean);
  };
  const whole = Math.floor(n);
  if (whole === 0) return currency === "USD" ? "ноль долларов США" : "ноль сум";
  const groups: [number, [string, string, string] | null, boolean][] = [
    [Math.floor(whole / 1e9) % 1000, ["миллиард", "миллиарда", "миллиардов"], false],
    [Math.floor(whole / 1e6) % 1000, ["миллион", "миллиона", "миллионов"], false],
    [Math.floor(whole / 1e3) % 1000, ["тысяча", "тысячи", "тысяч"], true],
    [whole % 1000, null, false],
  ];
  const words: string[] = [];
  for (const [value, names, feminine] of groups) {
    if (!value) continue;
    words.push(...triple(value, feminine));
    if (names) words.push(form(value, names));
  }
  const unit = currency === "USD" ? form(whole, ["доллар США", "доллара США", "долларов США"]) : "сум";
  const text = `${words.join(" ")} ${unit}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function renderInvoicePage(invoice: Invoice, client: Client, seriesTitle: string): string {
  const c = config.company;
  const plan = PLANS[invoice.plan];
  const rate = c.usdRate > 0 ? c.usdRate : 0;
  const uzs = rate ? Math.round(invoice.amountUsd * rate) : 0;
  const period = `${day(invoice.periodStart)} — ${day(invoice.periodEnd, -1)}`;
  const service = `Производство анимационного сериала «${seriesTitle}» для Instagram Reels, тариф «${plan.name}» (${plan.episodes} серий), период ${period}`;
  const row = (label: string, value: string | undefined) => (value ? `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>` : "");
  const total = rate ? money(uzs, "UZS") : money(invoice.amountUsd, "USD");
  const words = rate ? amountInWords(uzs, "UZS") : amountInWords(invoice.amountUsd, "USD");

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Счёт № ${esc(invoice.number)} — ${esc(client.company)}</title>
<style>
:root { --ink: #111A2C; --muted: #586378; --line: #D3DCE6; --accent: #0B6E8E; --bg: #EEF2F6; --paper: #FFFFFF; --good: #1E7D50; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --ink: #E7ECF5; --muted: #97A3BA; --line: #26324A; --accent: #43B6D6; --bg: #0B111D; --paper: #131B2B; --good: #4CC48D; color-scheme: dark; } }
:root[data-theme="dark"] { --ink: #E7ECF5; --muted: #97A3BA; --line: #26324A; --accent: #43B6D6; --bg: #0B111D; --paper: #131B2B; --good: #4CC48D; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 "Manrope", system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px 16px; }
.sheet { max-width: 820px; margin: 0 auto; background: var(--paper); border: 1px solid var(--line); border-radius: 14px; padding: 32px 28px; }
.bar { max-width: 820px; margin: 0 auto 14px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: center; }
.bar button { border: 0; background: var(--accent); color: #fff; font: inherit; font-weight: 700; padding: 10px 16px; border-radius: 10px; cursor: pointer; }
.status { font-weight: 700; color: ${invoice.status === "paid" ? "var(--good)" : "var(--muted)"}; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 24px; }
.parties { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); margin-bottom: 24px; }
.parties h2 { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 0 0 6px; }
.parties table { border-collapse: collapse; width: 100%; }
.parties th { text-align: left; font-weight: 500; color: var(--muted); padding: 2px 10px 2px 0; vertical-align: top; white-space: nowrap; }
.parties td { padding: 2px 0; overflow-wrap: anywhere; }
.items { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
.items th, .items td { border: 1px solid var(--line); padding: 8px 10px; vertical-align: top; }
.items th { background: color-mix(in srgb, var(--line) 35%, transparent); text-align: left; font-size: 12.5px; }
.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.total { text-align: right; font-size: 16px; margin: 0 0 4px; }
.words { text-align: right; color: var(--muted); margin: 0 0 24px; }
.note { color: var(--muted); font-size: 12.5px; }
.signs { display: grid; gap: 24px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); margin-top: 36px; }
.signs div { border-top: 1px solid var(--ink); padding-top: 4px; color: var(--muted); font-size: 12.5px; }
@media print {
  body { background: #fff; color: #000; padding: 0; }
  .bar { display: none; }
  .sheet { border: 0; border-radius: 0; padding: 0; max-width: none; background: #fff; }
  .parties th, .sub, .words, .note, .signs div { color: #333; }
  .items th { background: #f0f0f0; }
}
</style>
</head>
<body>
<div class="bar"><span class="status">${invoice.status === "paid" ? `Оплачен ${invoice.paidAt ? esc(day(invoice.paidAt)) : ""}` : "Ожидает оплаты"}</span><button type="button" onclick="window.print()">Печать / PDF</button></div>
<main class="sheet">
  <h1>Счёт на оплату № ${esc(invoice.number)}</h1>
  <p class="sub">Hisob-faktura · от ${esc(day(invoice.issuedAt))}</p>
  <div class="parties">
    <section><h2>Исполнитель</h2><table>
      ${row("Название", c.name)}${row("ИНН", c.inn)}${row("Адрес", c.address)}${row("Банк", c.bank)}${row("Р/с", c.account)}${row("МФО", c.mfo)}${row("Телефон", c.phone)}
    </table></section>
    <section><h2>Заказчик</h2><table>
      ${row("Название", client.legal?.name || client.company)}${row("ИНН", client.legal?.inn)}${row("Адрес", client.legal?.address)}${row("Контакт", client.contactName)}${row("Телефон", client.phone)}
    </table></section>
  </div>
  <table class="items">
    <thead><tr><th>№</th><th>Наименование</th><th class="num">Кол-во</th><th class="num">Цена</th><th class="num">Сумма</th></tr></thead>
    <tbody><tr>
      <td>1</td><td>${esc(service)}</td><td class="num">1</td>
      <td class="num">${esc(rate ? money(uzs, "UZS") : money(invoice.amountUsd, "USD"))}</td>
      <td class="num">${esc(rate ? money(uzs, "UZS") : money(invoice.amountUsd, "USD"))}</td>
    </tr></tbody>
  </table>
  <p class="total"><b>Итого к оплате: ${esc(total)}</b></p>
  <p class="words">${esc(words)}${rate ? ` (${esc(money(invoice.amountUsd, "USD"))} по курсу ${esc(rate.toLocaleString("ru-RU"))} сум)` : ""}. ${esc(c.vatNote)}.</p>
  <p class="note">В назначении платежа укажите: «Оплата по счёту № ${esc(invoice.number)}».</p>
  <div class="signs"><div>Руководитель ${c.director ? `· ${esc(c.director)}` : ""}</div><div>Подпись и печать</div></div>
</main>
</body>
</html>`;
}
