import { STARTER_AGENTS } from "./agents/index.js";
import { spentToday } from "./budget.js";
import { config } from "./config.js";
import { isStepDone, STEPS, type Step } from "./pipeline.js";
import { ENGINE_LABEL, engineStatus, isEngine, resolveEngine } from "./providers/engines.js";
import { listEpisodes, listSeries } from "./store.js";
import { type Episode, STATUS_LABEL, type Series } from "./types.js";

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
}

export interface UiBrand {
  slug: string;
  title: string;
  logline: string;
  language: string;
  client?: { company: string; product: string };
  characters: { id: string; name: string; role: string; color: string }[];
  rubrics: string[];
  stats: { episodes: number; waiting: number; published: number; costUsd: number };
}

export interface StudioState {
  generatedAt: string;
  defaultSeries: string;
  brands: UiBrand[];
  providers: Record<"claude" | "tts" | "telegram" | "instagram" | "publicUrl", boolean>;
  engines: { engine: string; label: string; available: boolean }[];
  autoEngine: string;
  budget: { spent: number; limit: number };
  schedule: { dailyAt: string; timezone: string; episodesPerDay: number };
  steps: { key: Step; label: string; agents: number[] }[];
  agents: { no: number; name: string; dept: string; does: string }[];
  episodes: UiEpisode[];
}

/** Как интерфейс получает ссылку на файл эпизода (на сервере — /media/...). */
export type MediaUrl = (ep: Episode, file: string) => string;

export const serverMediaUrl: MediaUrl = (ep, file) => `/media/${ep.id}/${file}`;

function engineLabel(ep: Episode): string | undefined {
  const used = ep.engines?.video ?? ep.engines?.image;
  if (used && isEngine(used)) return ENGINE_LABEL[used];
  if (ep.engineChoice && isEngine(ep.engineChoice)) return ENGINE_LABEL[ep.engineChoice];
  return undefined;
}

export function toUiEpisode(ep: Episode, seriesTitle: string, mediaUrl: MediaUrl = serverMediaUrl): UiEpisode {
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
  };
}

function toUiBrand(series: Series, episodes: Episode[]): UiBrand {
  const own = episodes.filter((e) => e.series === series.slug);
  return {
    slug: series.slug,
    title: series.title,
    logline: series.logline,
    language: series.language,
    client: series.client ? { company: series.client.company, product: series.client.product } : undefined,
    characters: series.characters.map((c, i) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      color: c.color ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length]!,
    })),
    rubrics: series.rubrics,
    stats: {
      episodes: own.length,
      waiting: own.filter((e) => e.status === "awaiting_approval" || e.status === "awaiting_feedback").length,
      published: own.filter((e) => e.status === "published").length,
      costUsd: Math.round(own.reduce((s, e) => s + e.costUsd, 0) * 100) / 100,
    },
  };
}

function autoEngineLabel(): string {
  try {
    return ENGINE_LABEL[resolveEngine("auto", "video")];
  } catch {
    return ENGINE_LABEL.mock;
  }
}

export function buildStudioState(opts: { episodes?: Episode[]; mediaUrl?: MediaUrl } = {}): StudioState {
  const series = listSeries();
  const titles = new Map(series.map((s) => [s.slug, s.title]));
  const all = opts.episodes ?? listEpisodes();
  return {
    generatedAt: new Date().toISOString(),
    defaultSeries: config.series,
    brands: series.map((s) => toUiBrand(s, all)),
    providers: {
      claude: config.llm.provider === "claude",
      tts: config.tts.provider === "azure",
      telegram: config.telegram.token !== "" && config.telegram.adminChatId !== "",
      instagram: config.instagram.token !== "" && config.instagram.userId !== "",
      publicUrl: config.server.publicBaseUrl !== "",
    },
    engines: engineStatus(),
    autoEngine: autoEngineLabel(),
    budget: { spent: Math.round(spentToday() * 100) / 100, limit: config.budget.dailyUsd },
    schedule: { dailyAt: config.schedule.dailyAt, timezone: config.schedule.timezone, episodesPerDay: config.schedule.episodesPerDay },
    steps: STEPS.map((key) => ({ key, ...STEP_INFO[key] })),
    agents: STARTER_AGENTS.map(({ no, name, dept, does }) => ({ no, name, dept, does })),
    episodes: all.slice(0, 60).map((ep) => toUiEpisode(ep, titles.get(ep.series) ?? ep.series, opts.mediaUrl)),
  };
}
