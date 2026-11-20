import fs from "node:fs";
import { STARTER_AGENTS } from "./agents/index.js";
import { type AuditEntry, recentAudit } from "./audit.js";
import type { Viewer } from "./auth.js";
import { localDay, spentToday } from "./budget.js";
import { type UpcomingOccasion, upcomingOccasions } from "./occasions.js";
import {
  APPROVAL_LABEL,
  APPROVAL_MODES,
  type Client,
  ensureInvoices,
  type Invoice,
  listClients,
  listInvoices,
  type PublicClient,
  publicClient,
} from "./clients.js";
import { config } from "./config.js";
import { type Lead, listLeads } from "./leads.js";
import { listReports, type WeeklyReport } from "./reports.js";
import { CHARACTER_VARIANTS, type CharacterVariant, characterAsset, isPlaceholder, locationAsset } from "./media/cutout.js";
import { isStepDone, STEPS, type Step } from "./pipeline.js";
import { PLAN_IDS, PLANS, type Plan } from "./plans.js";
import { ENGINE_LABEL, engineStatus, isEngine, resolveEngine } from "./providers/engines.js";
import { listEpisodes, listSeries } from "./store.js";
import { type ApprovalEntry, type Episode, STATUS_LABEL, type Series } from "./types.js";

/** Подписи шагов и агенты, которые их выполняют, — для прогресса в интерфейсе. */
export const STEP_INFO: Record<Step, { label: string; agents: number[] }> = {
  idea: { label: "Идея", agents: [7] },
  script: { label: "Сценарий", agents: [12] },
  hook: { label: "Хук", agents: [13] },
  shots: { label: "Промпты", agents: [21, 23] },
  keyframes: { label: "Кадры", agents: [35] },
  voice: { label: "Озвучка", agents: [51] },
  clips: { label: "Анимация", agents: [42] },
  edit: { label: "Монтаж", agents: [61] },
  subtitles: { label: "Субтитры", agents: [63] },
  qa: { label: "Проверка", agents: [71] },
  approval: { label: "Одобрение", agents: [80] },
};

const FALLBACK_COLORS = ["#0B6E8E", "#C2185B", "#C9772B", "#5B6BD8", "#2E8B57", "#8E44AD"];

export interface UiEpisode {
  id: string;
  series: string;
  seriesTitle: string;
  status: Episode["status"];
  statusLabel: string;
  step?: string;
  stepsDone: number;
  title: string;
  logline: string;
  brief?: string;
  engine?: string;
  createdAt: string;
  costUsd: number;
  duration?: number;
  error?: string;
  hook?: string;
  qa?: { pass: boolean; summary: string; issues: string[] };
  lines: { scene: number; character: string; text: string; ru: string }[];
  caption?: string;
  hashtags: string[];
  feedback: string[];
  video?: string;
  poster?: string;
  publish?: { permalink?: string; note?: string; dryRun?: boolean; at: string };
  /** Кто заказал: студия, автопилот, клиент. */
  orderedBy?: string;
  /** Чьи правки ждём после «Переделать». */
  feedbackFrom?: "studio" | "client";
  approvalLog: ApprovalEntry[];
  /** Компания-клиент бренда, если есть. */
  clientCompany?: string;
}

export interface UiAsset {
  id: string;
  name: string;
  /** Ссылка на картинку для перекладки; нет — картинки ещё нет. */
  art?: string;
  /** true — сейчас стоит заглушка студии, а не настоящий рисунок. */
  placeholder: boolean;
  /** Состояния героя для живой перекладки: ссылки на «рот открыт» и «глаза закрыты». */
  talk?: string;
  blink?: string;
  /** Обучение героя в Higgsfield (Soul ID): статус и причина ошибки. */
  soul?: { status: string; failReason?: string };
}

export interface UiBrand {
  slug: string;
  title: string;
  logline: string;
  language: string;
  client?: { company: string; product: string };
  characters: (UiAsset & { role: string; color: string })[];
  locations: UiAsset[];
  rubrics: string[];
  stats: { episodes: number; waiting: number; published: number; costUsd: number };
}

export type UiInvoice = Invoice & { company: string; planName: string; url: string };
/** Ссылка на страницу счёта (на сервере — /invoices/<id>, в превью — готовый файл). */
export type InvoiceUrl = (invoice: Invoice) => string;

export interface StudioState {
  generatedAt: string;
  role: "owner" | "client";
  defaultSeries: string;
  brands: UiBrand[];
  providers: Record<"claude" | "tts" | "telegram" | "instagram" | "publicUrl", boolean> & {
    llm: "claude" | "gemini" | "mock";
    voice: "azure" | "gemini" | "mock";
  };
  engines: { engine: string; label: string; available: boolean; free: boolean }[];
  autoEngine: string;
  budget: { spent: number; limit: number };
  schedule: { dailyAt: string; timezone: string; episodesPerDay: number };
  steps: { key: Step; label: string; agents: number[] }[];
  agents: { no: number; name: string; dept: string; does: string }[];
  episodes: UiEpisode[];
  plans: Plan[];
  approvalModes: { id: string; label: string }[];
  /** Ближайшие праздники и поводы — подсказки для заданий. */
  occasions: UpcomingOccasion[];
  /** Только у владельца студии. */
  clients?: PublicClient[];
  invoices?: UiInvoice[];
  leads?: Lead[];
  audit?: AuditEntry[];
  /** Последние отчёты за неделю (у владельца — по всем клиентам). */
  reports?: WeeklyReport[];
  /** Только у клиента: его карточка, тариф, счета и отчёты. */
  me?: PublicClient & { features: string[]; invoices: UiInvoice[]; weeklyReport: boolean };
}

/** Как интерфейс получает ссылку на файл эпизода (на сервере — /media/...). */
export type MediaUrl = (ep: Episode, file: string) => string;
/** Ссылка на картинку героя или локации (на сервере — /assets/...). */
export type AssetUrl = (slug: string, kind: "characters" | "locations", id: string, file: string, variant?: CharacterVariant) => string;

export const serverMediaUrl: MediaUrl = (ep, file) => `/media/${ep.id}/${file}`;

/** Версия в ссылке — по времени файла: после замены картинки браузер не покажет старую из кеша. */
export const serverAssetUrl: AssetUrl = (slug, kind, id, file, variant) =>
  `/assets/${slug}/${kind}/${id}${variant ? `.${variant}` : ""}.png?v=${Math.round(fs.statSync(file).mtimeMs)}`;

function engineLabel(ep: Episode): string | undefined {
  const used = ep.engines?.video ?? ep.engines?.image;
  if (used && isEngine(used)) return ENGINE_LABEL[used];
  if (ep.engineChoice && isEngine(ep.engineChoice)) return ENGINE_LABEL[ep.engineChoice];
  return undefined;
}

export function toUiEpisode(ep: Episode, seriesTitle: string, mediaUrl: MediaUrl = serverMediaUrl, clientCompany?: string): UiEpisode {
  const posterFile = ep.keyframes?.s1 ?? (ep.shots?.[0] ? ep.keyframes?.[ep.shots[0].scene_id] : undefined);
  const qaIssues = ep.qa ? [...ep.qa.tech.problems, ...ep.qa.review.issues.map((i) => i.note)] : [];
  return {
    id: ep.id,
    series: ep.series,
    seriesTitle,
    status: ep.status,
    statusLabel: STATUS_LABEL[ep.status],
    step: ep.step,
    stepsDone: STEPS.filter((s) => isStepDone(ep, s)).length,
    title: ep.script?.title ?? ep.idea?.title ?? "Новая серия",
    logline: ep.idea?.logline ?? "",
    brief: ep.brief,
    engine: engineLabel(ep),
    createdAt: ep.createdAt,
    costUsd: ep.costUsd,
    duration: ep.voice?.total,
    error: ep.error,
    hook: ep.hook?.on_screen_text,
    qa: ep.qa ? { pass: ep.qa.pass, summary: ep.qa.review.summary_ru, issues: qaIssues } : undefined,
    lines: (ep.script?.scenes ?? []).flatMap((scene, i) =>
      scene.lines.map((l) => ({ scene: i + 1, character: l.character, text: l.text, ru: l.translation_ru })),
    ),
    caption: ep.script?.caption,
    hashtags: ep.script?.hashtags ?? [],
    feedback: ep.feedback,
    video: ep.final ? mediaUrl(ep, ep.final) : undefined,
    poster: posterFile ? mediaUrl(ep, posterFile) : undefined,
    publish: ep.publish ? { permalink: ep.publish.permalink, note: ep.publish.note, dryRun: ep.publish.dryRun, at: ep.publish.at } : undefined,
    orderedBy: ep.orderedBy,
    feedbackFrom: ep.feedbackFrom,
    approvalLog: ep.approvalLog ?? [],
    clientCompany,
  };
}

/** Видит ли клиент саму серию (ролик, сценарий): только после того, как студия передала её клиенту. */
function clientCanSee(ep: Episode): boolean {
  return (
    ep.status === "awaiting_client" ||
    ep.status === "approved" ||
    ep.status === "published" ||
    (ep.status === "awaiting_feedback" && ep.feedbackFrom === "client")
  );
}

/**
 * Серия глазами клиента: без расходов, движков, внутренних заметок студии и черновиков.
 * Пока серия у студии, клиент видит только «в работе» и прогресс.
 */
function forClient(ui: UiEpisode, ep: Episode): UiEpisode {
  const visible = clientCanSee(ep);
  const waitingMe = ep.status === "awaiting_client" || (ep.status === "awaiting_feedback" && ep.feedbackFrom === "client");
  const label = waitingMe
    ? "👀 ждёт вашего решения"
    : ep.status === "published"
      ? "📢 опубликован"
      : ep.status === "approved"
        ? "✅ одобрен"
        : "⚙️ в работе у студии";
  const base: UiEpisode = {
    ...ui,
    statusLabel: label,
    costUsd: 0,
    engine: undefined,
    error: undefined,
    qa: undefined,
    feedback: ep.feedback.filter((f) => f.startsWith("Клиент:")).map((f) => f.replace(/^Клиент:\s*/, "")),
    approvalLog: ui.approvalLog.filter((a) => a.by === "client" || a.decision === "sent_to_client"),
    step: undefined,
    publish: ui.publish ? { ...ui.publish, note: ui.publish.dryRun ? "Серия одобрена — студия опубликует её в ближайшее время." : undefined } : undefined,
  };
  if (visible) return base;
  return { ...base, title: ep.brief ? "Серия по вашему заданию" : "Новая серия", logline: "", hook: undefined, lines: [], caption: undefined, hashtags: [], video: undefined, poster: undefined };
}

function assetInfo(slug: string, kind: "characters" | "locations", id: string, name: string, assetUrl: AssetUrl): UiAsset {
  let file: string;
  try {
    file = kind === "characters" ? characterAsset(slug, id) : locationAsset(slug, id);
  } catch {
    return { id, name, placeholder: true };
  }
  if (!fs.existsSync(file)) return { id, name, placeholder: true };
  const info: UiAsset = { id, name, art: assetUrl(slug, kind, id, file), placeholder: isPlaceholder(file) };
  if (kind === "characters") {
    for (const variant of CHARACTER_VARIANTS) {
      const extra = characterAsset(slug, id, variant);
      if (fs.existsSync(extra)) info[variant] = assetUrl(slug, kind, id, extra, variant);
    }
  }
  return info;
}

function toUiBrand(series: Series, episodes: Episode[], assetUrl: AssetUrl): UiBrand {
  const own = episodes.filter((e) => e.series === series.slug);
  return {
    slug: series.slug,
    title: series.title,
    logline: series.logline,
    language: series.language,
    client: series.client ? { company: series.client.company, product: series.client.product } : undefined,
    characters: series.characters.map((c, i) => ({
      ...assetInfo(series.slug, "characters", c.id, c.name, assetUrl),
      ...(c.higgsfield_ref ? { soul: { status: c.higgsfield_ref.status, failReason: c.higgsfield_ref.failReason } } : {}),
      role: c.role,
      color: c.color ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length]!,
    })),
    locations: series.locations.map((l) => assetInfo(series.slug, "locations", l.id, l.name, assetUrl)),
    rubrics: series.rubrics,
    stats: {
      episodes: own.length,
      waiting: own.filter((e) => ["awaiting_approval", "awaiting_feedback", "awaiting_client"].includes(e.status)).length,
      published: own.filter((e) => e.status === "published").length,
      costUsd: Math.round(own.reduce((s, e) => s + e.costUsd, 0) * 100) / 100,
    },
  };
}

function autoEngineLabel(): string {
  try {
    return ENGINE_LABEL[resolveEngine("auto", "video")];
  } catch {
    return ENGINE_LABEL.cutout;
  }
}

function uiInvoices(invoices: Invoice[], clients: Client[], invoiceUrl: InvoiceUrl): UiInvoice[] {
  const byId = new Map(clients.map((c) => [c.id, c]));
  return invoices.map((i) => ({ ...i, company: byId.get(i.clientId)?.company ?? i.clientId, planName: PLANS[i.plan].name, url: invoiceUrl(i) }));
}

export function buildStudioState(
  opts: { viewer?: Viewer; episodes?: Episode[]; mediaUrl?: MediaUrl; assetUrl?: AssetUrl; invoiceUrl?: InvoiceUrl } = {},
): StudioState {
  const viewer: Viewer = opts.viewer ?? { role: "owner" };
  ensureInvoices();
  const clients = listClients();
  const companyOf = new Map(clients.map((c) => [c.brand, c.company]));
  const series = listSeries();
  const titles = new Map(series.map((s) => [s.slug, s.title]));
  const all = opts.episodes ?? listEpisodes();
  const assetUrl = opts.assetUrl ?? serverAssetUrl;
  const invoiceUrl: InvoiceUrl = opts.invoiceUrl ?? ((i) => `/invoices/${i.id}`);

  const common = {
    generatedAt: new Date().toISOString(),
    steps: STEPS.map((key) => ({ key, ...STEP_INFO[key] })),
    plans: PLAN_IDS.map((id) => PLANS[id]),
    approvalModes: APPROVAL_MODES.map((id) => ({ id, label: APPROVAL_LABEL[id] })),
    occasions: upcomingOccasions(localDay(), 45, viewer.role === "client" ? viewer.client.brand : undefined).slice(0, 6),
  };

  if (viewer.role === "client") {
    const me = viewer.client;
    const mine = all.filter((e) => e.series === me.brand && e.status !== "rejected");
    const brand = series.filter((s) => s.slug === me.brand).map((s) => toUiBrand(s, mine, assetUrl));
    for (const b of brand) b.stats.costUsd = 0;
    return {
      ...common,
      role: "client",
      defaultSeries: me.brand,
      brands: brand,
      providers: { claude: false, tts: false, telegram: config.telegram.token !== "", instagram: Boolean(me.instagram), publicUrl: false, llm: "mock", voice: "mock" },
      engines: [],
      autoEngine: "",
      budget: { spent: 0, limit: 0 },
      schedule: { dailyAt: "", timezone: config.schedule.timezone, episodesPerDay: 0 },
      agents: [],
      episodes: mine.slice(0, 60).map((ep) => forClient(toUiEpisode(ep, titles.get(ep.series) ?? ep.series, opts.mediaUrl), ep)),
      me: { ...publicClient(me), features: PLANS[me.plan].features, invoices: uiInvoices(listInvoices(me.id), clients, invoiceUrl), weeklyReport: PLANS[me.plan].weeklyReport },
      reports: listReports(me.id).slice(0, 8),
    };
  }

  return {
    ...common,
    role: "owner",
    defaultSeries: config.series,
    brands: series.map((s) => toUiBrand(s, all, assetUrl)),
    providers: {
      claude: config.llm.provider === "claude",
      tts: config.tts.provider !== "mock",
      telegram: config.telegram.token !== "" && config.telegram.adminChatId !== "",
      instagram: config.instagram.token !== "" && config.instagram.userId !== "",
      publicUrl: config.server.publicBaseUrl !== "",
      llm: config.llm.provider,
      voice: config.tts.provider,
    },
    engines: engineStatus(),
    autoEngine: autoEngineLabel(),
    budget: { spent: Math.round(spentToday() * 100) / 100, limit: config.budget.dailyUsd },
    schedule: { dailyAt: config.schedule.dailyAt, timezone: config.schedule.timezone, episodesPerDay: config.schedule.episodesPerDay },
    agents: STARTER_AGENTS.map(({ no, name, dept, does }) => ({ no, name, dept, does })),
    episodes: all.slice(0, 80).map((ep) => toUiEpisode(ep, titles.get(ep.series) ?? ep.series, opts.mediaUrl, companyOf.get(ep.series))),
    clients: clients.map((c) => publicClient(c)),
    invoices: uiInvoices(listInvoices(), clients, invoiceUrl),
    leads: listLeads(50),
    reports: listReports().slice(0, 40),
    audit: recentAudit(60),
  };
}
