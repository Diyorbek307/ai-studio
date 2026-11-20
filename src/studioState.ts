import { STARTER_AGENTS } from "./agents/index.js";
import { spentToday } from "./budget.js";
import { config } from "./config.js";
import { isStepDone, STEPS, type Step } from "./pipeline.js";
import { listEpisodes, loadSeries } from "./store.js";
import { type Episode, STATUS_LABEL } from "./types.js";

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

const FALLBACK_COLORS = ["#0E6F8F", "#C2185B", "#C9772B", "#5B6BD8", "#2E8B57", "#8E44AD"];

export interface UiEpisode {
  id: string;
  status: Episode["status"];
  statusLabel: string;
  step?: string;
  stepsDone: number;
  title: string;
  logline: string;
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

export interface StudioState {
  generatedAt: string;
  series: { slug: string; title: string; logline: string };
  characters: { id: string; name: string; role: string; color: string }[];
  providers: Record<"claude" | "image" | "video" | "tts" | "telegram" | "instagram" | "publicUrl", boolean>;
  budget: { spent: number; limit: number };
  schedule: { dailyAt: string; timezone: string; episodesPerDay: number };
  steps: { key: Step; label: string; agents: number[] }[];
  agents: { no: number; name: string; dept: string; does: string }[];
  episodes: UiEpisode[];
}

/** Как интерфейс получает ссылку на файл эпизода (на сервере — /media/...). */
export type MediaUrl = (ep: Episode, file: string) => string;

export const serverMediaUrl: MediaUrl = (ep, file) => `/media/${ep.id}/${file}`;

export function toUiEpisode(ep: Episode, mediaUrl: MediaUrl = serverMediaUrl): UiEpisode {
  const posterFile = ep.keyframes?.s1 ?? (ep.shots?.[0] ? ep.keyframes?.[ep.shots[0].scene_id] : undefined);
  const qaIssues = ep.qa ? [...ep.qa.tech.problems, ...ep.qa.review.issues.map((i) => i.note)] : [];
  return {
    id: ep.id,
    status: ep.status,
    statusLabel: STATUS_LABEL[ep.status],
    step: ep.step,
    stepsDone: STEPS.filter((s) => isStepDone(ep, s)).length,
    title: ep.script?.title ?? ep.idea?.title ?? "Новая серия",
    logline: ep.idea?.logline ?? "",
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

export function buildStudioState(opts: { episodes?: Episode[]; mediaUrl?: MediaUrl } = {}): StudioState {
  const series = loadSeries(config.series);
  const episodes = (opts.episodes ?? listEpisodes()).slice(0, 40);
  return {
    generatedAt: new Date().toISOString(),
    series: { slug: series.slug, title: series.title, logline: series.logline },
    characters: series.characters.map((c, i) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      color: c.color ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length]!,
    })),
    providers: {
      claude: config.llm.provider === "claude",
      image: config.image.provider === "fal",
      video: config.video.provider === "fal",
      tts: config.tts.provider === "azure",
      telegram: config.telegram.token !== "" && config.telegram.adminChatId !== "",
      instagram: config.instagram.token !== "" && config.instagram.userId !== "",
      publicUrl: config.server.publicBaseUrl !== "",
    },
    budget: { spent: Math.round(spentToday() * 100) / 100, limit: config.budget.dailyUsd },
    schedule: { dailyAt: config.schedule.dailyAt, timezone: config.schedule.timezone, episodesPerDay: config.schedule.episodesPerDay },
    steps: STEPS.map((key) => ({ key, ...STEP_INFO[key] })),
    agents: STARTER_AGENTS.map(({ no, name, dept, does }) => ({ no, name, dept, does })),
    episodes: episodes.map((ep) => toUiEpisode(ep, opts.mediaUrl)),
  };
}
