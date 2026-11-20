import { z } from "zod";

// ---------- Библия сериала (series/<slug>.json) ----------

export const CharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  personality: z.string(),
  look: z.string(),
  /** Канонический промпт внешности на английском — пишет Дизайнер персонажей (№ 21). */
  visual_prompt: z.string().optional(),
  catchphrases: z.array(z.string()).default([]),
  voice: z
    .object({
      azure: z.string().optional(),
      rate: z.string().optional(),
      pitch: z.string().optional(),
    })
    .default({}),
});
export type Character = z.infer<typeof CharacterSchema>;

export const LocationSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});

export const SeriesSchema = z.object({
  slug: z.string(),
  title: z.string(),
  language: z.enum(["uz", "ru", "en"]).default("uz"),
  logline: z.string(),
  tone: z.string(),
  audience: z.string(),
  style_guide: z.string(),
  /** Канонический стиль на английском — пишет Дизайнер персонажей (№ 21). */
  style_prompt: z.string().optional(),
  locations: z.array(LocationSchema),
  characters: z.array(CharacterSchema),
  rubrics: z.array(z.string()).default([]),
  rules: z.array(z.string()).default([]),
  target_duration_sec: z.number().default(30),
  hashtags: z.array(z.string()).default([]),
});
export type Series = z.infer<typeof SeriesSchema>;

// ---------- Ответы агентов (структурированный вывод Claude) ----------
// Все поля обязательные: так схема без сюрпризов проходит через structured outputs.

export const IdeaSchema = z.object({
  title: z.string(),
  logline: z.string(),
  characters: z.array(z.string()),
  location: z.string(),
  hook_idea: z.string(),
  why_it_works: z.string(),
  score: z.number(),
});
export type Idea = z.infer<typeof IdeaSchema>;

export const IdeaBatchSchema = z.object({
  ideas: z.array(IdeaSchema),
  chosen_index: z.number(),
  reason: z.string(),
});

export const LineSchema = z.object({
  character: z.string(),
  text: z.string(),
  translation_ru: z.string(),
  emotion: z.string(),
});
export type Line = z.infer<typeof LineSchema>;

export const SceneSchema = z.object({
  id: z.string(),
  location: z.string(),
  characters: z.array(z.string()),
  visual: z.string(),
  camera: z.string(),
  lines: z.array(LineSchema),
  duration_sec: z.number(),
});
export type Scene = z.infer<typeof SceneSchema>;

export const ScriptSchema = z.object({
  title: z.string(),
  scenes: z.array(SceneSchema),
  caption: z.string(),
  caption_ru: z.string(),
  hashtags: z.array(z.string()),
  cliffhanger: z.string(),
});
export type Script = z.infer<typeof ScriptSchema>;

export const HookSchema = z.object({
  variants: z.array(
    z.object({
      opening_line: z.string(),
      opening_line_ru: z.string(),
      on_screen_text: z.string(),
      visual: z.string(),
    }),
  ),
  chosen_index: z.number(),
  reason: z.string(),
});
export type HookResult = z.infer<typeof HookSchema>;

export const DesignSchema = z.object({
  style_prompt: z.string(),
  characters: z.array(z.object({ id: z.string(), visual_prompt: z.string() })),
});

export const ShotSchema = z.object({
  scene_id: z.string(),
  image_prompt: z.string(),
  motion_prompt: z.string(),
});
export type Shot = z.infer<typeof ShotSchema>;
export const ShotListSchema = z.object({ shots: z.array(ShotSchema) });

export const QaReviewSchema = z.object({
  pass: z.boolean(),
  issues: z.array(
    z.object({
      severity: z.enum(["blocker", "minor"]),
      area: z.enum(["script", "visual", "audio", "subtitles", "other"]),
      note: z.string(),
    }),
  ),
  redo_from: z.enum(["none", "script", "shots", "voice", "edit"]),
  summary_ru: z.string(),
});
export type QaReview = z.infer<typeof QaReviewSchema>;

export const InsightsSchema = z.object({
  summary_ru: z.string(),
  what_works: z.array(z.string()),
  what_to_avoid: z.array(z.string()),
  next_ideas_hints: z.array(z.string()),
});
export type Insights = z.infer<typeof InsightsSchema>;

// ---------- Эпизод (data/episodes/<id>/episode.json) ----------

export const EPISODE_STATUSES = [
  "in_progress",
  "awaiting_approval",
  "awaiting_feedback",
  "approved",
  "published",
  "rejected",
  "paused_budget",
  "failed",
] as const;
export type EpisodeStatus = (typeof EPISODE_STATUSES)[number];

export const STATUS_LABEL: Record<EpisodeStatus, string> = {
  in_progress: "⚙️ в работе",
  awaiting_approval: "👀 ждёт одобрения",
  awaiting_feedback: "✍️ ждёт правок",
  approved: "✅ одобрен",
  published: "📢 опубликован",
  rejected: "🗑 отклонён",
  paused_budget: "⏸ пауза: бюджет",
  failed: "❌ ошибка",
};

export interface VoiceLine {
  sceneId: string;
  index: number;
  character: string;
  text: string;
  file: string;
  start: number;
  end: number;
}

export interface VoiceTimeline {
  lines: VoiceLine[];
  scenes: { sceneId: string; start: number; end: number }[];
  total: number;
}

export interface TechCheck {
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
  sizeMb: number;
  problems: string[];
}

export interface QaReport {
  tech: TechCheck;
  review: QaReview;
  pass: boolean;
  checkedAt: string;
}

export interface Episode {
  id: string;
  series: string;
  createdAt: string;
  updatedAt: string;
  status: EpisodeStatus;
  /** Шаг, на котором остановились (для «Продолжить»). */
  step?: string;
  error?: string;
  /** Замечания от тебя и от контролёра качества: сценарист учитывает их при переделке. */
  feedback: string[];
  attempts: Record<string, number>;
  costUsd: number;

  idea?: Idea;
  ideaAlternatives?: Idea[];
  script?: Script;
  hook?: { opening_line: string; opening_line_ru: string; on_screen_text: string; visual: string };
  shots?: Shot[];
  keyframes?: Record<string, string>;
  clips?: Record<string, string>;
  voice?: VoiceTimeline;
  edited?: string;
  subtitles?: string;
  final?: string;
  qa?: QaReport;
  approval?: {
    requestedAt?: string;
    telegramMessageId?: number;
    decidedAt?: string;
    decision?: "approved" | "redo" | "rejected";
  };
  publish?: {
    at: string;
    mediaId?: string;
    permalink?: string;
    dryRun?: boolean;
    note?: string;
  };
  stats?: { fetchedAt: string; metrics: Record<string, number> };
}
