import fs from "node:fs";
import path from "node:path";

// .env подхватывается сам, если он есть рядом с запуском.
const dotEnv = path.resolve(process.cwd(), ".env");
if (fs.existsSync(dotEnv)) process.loadEnvFile(dotEnv);

function str(key: string, fallback = ""): string {
  return (process.env[key] ?? fallback).trim();
}

function num(key: string, fallback: number): number {
  const raw = str(key);
  if (raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} должно быть числом, сейчас: "${raw}"`);
  return value;
}

function oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = str(key, fallback) as T;
  if (!allowed.includes(raw)) {
    throw new Error(`${key} может быть только ${allowed.join(" | ")}, сейчас: "${raw}"`);
  }
  return raw;
}

const hasClaudeKey = str("ANTHROPIC_API_KEY") !== "" || str("ANTHROPIC_AUTH_TOKEN") !== "";
const hasFal = str("FAL_KEY") !== "";
const hasAzure = str("AZURE_SPEECH_KEY") !== "";

export const config = {
  series: str("STUDIO_SERIES", "bozor-seriali"),
  dataDir: path.resolve(str("STUDIO_DATA_DIR", "data")),
  seriesDir: path.resolve(str("STUDIO_SERIES_DIR", "series")),
  musicDir: path.resolve(str("STUDIO_MUSIC_DIR", "music")),

  llm: {
    provider: oneOf("LLM_PROVIDER", ["claude", "mock"] as const, hasClaudeKey ? "claude" : "mock"),
    model: str("CLAUDE_MODEL", "claude-opus-5-5"),
    // Цены за 1M токенов, по ним считается расход (Claude Opus 5.5).
    priceInPerMTok: num("CLAUDE_PRICE_IN_PER_MTOK", 4),
    priceOutPerMTok: num("CLAUDE_PRICE_OUT_PER_MTOK", 20),
    priceCacheReadPerMTok: num("CLAUDE_PRICE_CACHE_READ_PER_MTOK", 0.2),
  },

  image: {
    provider: oneOf("IMAGE_PROVIDER", ["fal", "mock"] as const, hasFal ? "fal" : "mock"),
    falModel: str("FAL_IMAGE_MODEL", "fal-ai/flux/dev"),
    costUsd: num("IMAGE_COST_USD", 0.03),
  },

  video: {
    provider: oneOf("VIDEO_PROVIDER", ["fal", "mock"] as const, hasFal ? "fal" : "mock"),
    falModel: str("FAL_VIDEO_MODEL", "fal-ai/kling-video/v2.1/standard/image-to-video"),
    costPerSecUsd: num("VIDEO_COST_PER_SEC_USD", 0.06),
  },

  tts: {
    provider: oneOf("TTS_PROVIDER", ["azure", "mock"] as const, hasAzure ? "azure" : "mock"),
    azureKey: str("AZURE_SPEECH_KEY"),
    azureRegion: str("AZURE_SPEECH_REGION", "westeurope"),
    costPerCharUsd: num("TTS_COST_PER_CHAR_USD", 0.000016),
  },

  falKey: str("FAL_KEY"),

  telegram: {
    token: str("TELEGRAM_BOT_TOKEN"),
    adminChatId: str("TELEGRAM_ADMIN_CHAT_ID"),
  },

  instagram: {
    userId: str("IG_USER_ID"),
    token: str("IG_ACCESS_TOKEN"),
    graphVersion: str("IG_GRAPH_VERSION", "v23.0"),
    // graph.facebook.com — вход через Facebook; graph.instagram.com — вход через Instagram.
    graphHost: str("IG_GRAPH_HOST", "graph.facebook.com"),
    insightMetrics: str("IG_INSIGHT_METRICS", "views,reach,likes,comments,shares,saved"),
  },

  server: {
    port: num("PORT", 8080),
    publicBaseUrl: str("PUBLIC_BASE_URL").replace(/\/+$/, ""),
    adminPassword: str("STUDIO_ADMIN_PASSWORD"),
    production: str("NODE_ENV") === "production",
  },

  budget: {
    dailyUsd: num("DAILY_BUDGET_USD", 5),
  },

  schedule: {
    dailyAt: str("DAILY_AT"),
    timezone: str("STUDIO_TZ", "Asia/Tashkent"),
    episodesPerDay: num("EPISODES_PER_DAY", 1),
  },

  render: {
    width: 1080,
    height: 1920,
    fps: 30,
    subtitleFont: str("SUBTITLE_FONT", "DejaVu Sans"),
    subtitleFontsDir: str("SUBTITLE_FONTS_DIR"),
    musicVolume: num("MUSIC_VOLUME", 0.12),
  },

  maxQaRetries: num("MAX_QA_RETRIES", 1),
};

export type Config = typeof config;

/** Короткая сводка, какие сервисы настоящие, а какие в демо-режиме. */
export function describeProviders(): string {
  const mark = (real: boolean) => (real ? "настоящий" : "демо");
  return [
    `Claude: ${mark(config.llm.provider === "claude")}`,
    `картинки: ${mark(config.image.provider === "fal")}`,
    `видео: ${mark(config.video.provider === "fal")}`,
    `голос: ${mark(config.tts.provider === "azure")}`,
    `Telegram: ${config.telegram.token ? "подключён" : "нет"}`,
    `Instagram: ${config.instagram.token ? "подключён" : "нет"}`,
  ].join(" · ");
}
