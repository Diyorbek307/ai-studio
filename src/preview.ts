import fs from "node:fs";
import path from "node:path";
import { getClient, type Invoice, listClients } from "./clients.js";
import { renderInvoicePage } from "./invoicePage.js";
import { PLAN_IDS, PLANS } from "./plans.js";
import { LANDING_FILE, renderAppPage, showcaseFile, UI_FILE } from "./server.js";
import { episodeDir, listEpisodes, loadSeries } from "./store.js";
import { type AssetUrl, buildStudioState, type InvoiceUrl, type MediaUrl } from "./studioState.js";

function inject(file: string, vars: Record<string, unknown>): string {
  const ui = fs.readFileSync(file, "utf8");
  const at = ui.lastIndexOf("<script>");
  if (at === -1) throw new Error(`В ${path.basename(file)} нет основного скрипта`);
  const data = Object.entries(vars)
    .map(([k, v]) => `window.${k} = ${JSON.stringify(v).replace(/</g, "\\u003c")};`)
    .join("\n");
  return `${ui.slice(0, at)}<script>${data}</script>\n${ui.slice(at)}`;
}

/**
 * Превью без сервера: ui/app.html + снимок данных студии + файлы роликов и картинок героев рядом.
 * Если есть клиент, превью показывает и кабинет клиента (переключатель «Смотреть как»).
 * Рядом кладётся landing.html — сайт студии для компаний. Кнопки в превью ничего не меняют.
 */
export function buildPreview(outDir: string): { page: string; landing: string; media: string[] } {
  const media = new Set<string>();
  const copy = (from: string, rel: string): string => {
    if (!media.has(rel)) {
      const target = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(from, target);
      media.add(rel);
    }
    return rel;
  };
  const mediaUrl: MediaUrl = (ep, file) => copy(path.join(episodeDir(ep.id), file), `media/${ep.id}/${file}`);
  const assetUrl: AssetUrl = (slug, kind, id, file, variant) => copy(file, `assets/${slug}/${kind}/${id}${variant ? `.${variant}` : ""}.png`);

  // Счета в превью — готовые страницы рядом (на сервере их отдаёт /invoices/<id>).
  const invoiceUrl: InvoiceUrl = (invoice: Invoice) => {
    const rel = `invoices/${invoice.id}.html`;
    if (!media.has(rel)) {
      const client = getClient(invoice.clientId);
      const target = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, renderInvoicePage(invoice, client, loadSeries(client.brand).title));
      media.add(rel);
    }
    return rel;
  };

  const episodes = listEpisodes();
  const owner = buildStudioState({ episodes, mediaUrl, assetUrl, invoiceUrl });
  // Кабинет первого клиента, у которого уже есть серии на согласовании, иначе — первого клиента.
  const clients = listClients();
  const client =
    clients.find((c) => episodes.some((e) => e.series === c.brand && e.status === "awaiting_client")) ?? clients[0];
  const preview = client
    ? { views: { owner, client: buildStudioState({ viewer: { role: "client", client }, episodes, mediaUrl, assetUrl, invoiceUrl }) } }
    : owner;

  fs.mkdirSync(outDir, { recursive: true });
  const page = path.join(outDir, "index.html");
  fs.writeFileSync(page, inject(UI_FILE, { STUDIO_PREVIEW: preview }));
  const landing = path.join(outDir, "landing.html");
  // Отдельная страница рядом с превью — со своим <!doctype html>, как на сервере.
  const plans = PLAN_IDS.map((id) => PLANS[id]);
  fs.writeFileSync(landing, renderAppPage(fs.readFileSync(LANDING_FILE, "utf8"), "AI-студия — мультсериал для бренда", { STUDIO_PUBLIC: { plans } }));
  for (const [kind, id] of [["locations", "tandir"], ["characters", "somsa"], ["characters", "non"]] as const) {
    const file = showcaseFile(kind, id);
    if (file) copy(file, `showcase/${kind}/${id}.png`);
  }
  return { page, landing, media: [...media] };
}
