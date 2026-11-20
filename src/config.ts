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
const hasAzure = str("AZURE_SPEECH_KEY") !== "";

export const config = {
  series: str("STUDIO_SERIES", "bozor-seriali"),
  dataDir: path.resolve(str("STUDIO_DATA_DIR", "data")),
  seriesDir: path.resolve(str("STUDIO_SERIES_DIR", "series")),
  musicDir: path.resolve(str("STUDIO_MUSIC_DIR", "music")),

  llm: {
    // Мозг студии: Claude (лучшее качество), Gemini (есть бесплатный тариф) или демо.
    provider: oneOf(
      "LLM_PROVIDER",
      ["claude", "gemini", "mock"] as const,
      hasClaudeKey ? "claude" : str("GEMINI_API_KEY") !== "" ? "gemini" : "mock",
    ),
    model: str("CLAUDE_MODEL", "claude-opus-5-5"),
    geminiModel: str("GEMINI_TEXT_MODEL", "gemini-3.8-flash"),
    // На бесплатном тарифе Gemini текстовая модель ничего не стоит; на платном — задай цены.
    geminiPriceInPerMTok: num("GEMINI_TEXT_PRICE_IN_PER_MTOK", 0),
    geminiPriceOutPerMTok: num("GEMINI_TEXT_PRICE_OUT_PER_MTOK", 0),
    // Цены за 1M токенов, по ним считается расход (Claude Opus 5.5).
    priceInPerMTok: num("CLAUDE_PRICE_IN_PER_MTOK", 4),
    priceOutPerMTok: num("CLAUDE_PRICE_OUT_PER_MTOK", 20),
    priceCacheReadPerMTok: num("CLAUDE_PRICE_CACHE_READ_PER_MTOK", 0.2),
  },

  // Движок картинок и видео: auto — первый подключённый платный (grok → higgsfield → gemini → fal),
  // иначе бесплатная перекладка (cutout) из картинок героев и фонов сериала.
  image: {
    engine: oneOf("IMAGE_ENGINE", ["auto", "cutout", "gemini", "grok", "higgsfield", "fal", "mock"] as const, "auto"),
    falModel: str("FAL_IMAGE_MODEL", "fal-ai/flux/dev"),
    costUsd: num("IMAGE_COST_USD", 0.03),
  },

  video: {
    engine: oneOf("VIDEO_ENGINE", ["auto", "cutout", "gemini", "grok", "higgsfield", "fal", "mock"] as const, "auto"),
    falModel: str("FAL_VIDEO_MODEL", "fal-ai/kling-video/v2.1/standard/image-to-video"),
    costPerSecUsd: num("VIDEO_COST_PER_SEC_USD", 0.06),
  },

  gemini: {
    apiKey: str("GEMINI_API_KEY"),
    imageModel: str("GEMINI_IMAGE_MODEL", "gemini-nano-banana-2.1"),
    videoModel: str("GEMINI_VIDEO_MODEL", "gemini-omni-1.2-flash"),
    apiRevision: str("GEMINI_API_REVISION", "2026-05-20"),
    // Картинки (Nano Banana) и видео (Omni Flash) у Gemini только на платном тарифе — включаются явно.
    paidMedia: ["on", "true", "1"].includes(str("GEMINI_MEDIA").toLowerCase()),
    imageCostUsd: num("GEMINI_IMAGE_COST_USD", 0.04),
    // По прайсу Google: ~$0.07 за секунду видео 720p у Gemini Omni Flash.
    videoCostPerSecUsd: num("GEMINI_VIDEO_COST_PER_SEC_USD", 0.07),
  },

  grok: {
    apiKey: str("XAI_API_KEY"),
    imageModel: str("GROK_IMAGE_MODEL", "grok-imagine-image-2.0"),
    videoModel: str("GROK_VIDEO_MODEL", "grok-imagine-video-1.5"),
    videoResolution: str("GROK_VIDEO_RESOLUTION", "720p"),
  },

  higgsfield: {
    keyId: str("HIGGSFIELD_KEY_ID"),
    keySecret: str("HIGGSFIELD_KEY_SECRET"),
    imageEndpoint: str("HIGGSFIELD_IMAGE_ENDPOINT", "higgsfield-ai/soul/standard"),
    videoEndpoint: str("HIGGSFIELD_VIDEO_ENDPOINT", "kling-video/v3.0/std/image-to-video"),
    imageCostUsd: num("HIGGSFIELD_IMAGE_COST_USD", 0.09),
    videoCostPerSecUsd: num("HIGGSFIELD_VIDEO_COST_PER_SEC_USD", 0.1),
  },

  tts: {
    // Голоса: Azure Speech, Gemini TTS (бесплатный тариф, понимает узбекский) или демо-тишина.
    provider: oneOf(
      "TTS_PROVIDER",
      ["azure", "gemini", "mock"] as const,
      hasAzure ? "azure" : str("GEMINI_API_KEY") !== "" ? "gemini" : "mock",
    ),
    geminiModel: str("GEMINI_TTS_MODEL", "gemini-3.8-flash-tts"),
    geminiCostPerCharUsd: num("GEMINI_TTS_COST_PER_CHAR_USD", 0),
    azureKey: str("AZURE_SPEECH_KEY"),
    azureRegion: str("AZURE_SPEECH_REGION", "westeurope"),
    costPerCharUsd: num("TTS_COST_PER_CHAR_USD", 0.000016),
  },

  falKey: str("FAL_KEY"),

  telegram: {
    token: str("TELEGRAM_BOT_TOKEN"),
    adminChatId: str("TELEGRAM_ADMIN_CHAT_ID"),
    /** Имя бота без @ — для ссылки, по которой клиент подключает Telegram (иначе узнаём у Telegram). */
    botUsername: str("TELEGRAM_BOT_USERNAME"),
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

  /** Как часто спрашивать у движков готовность видео (мс). */
  pollMs: num("PROVIDER_POLL_MS", 5000),
};

export type Config = typeof config;

/** Короткая сводка, какие сервисы настоящие, а какие в демо-режиме. */
export function describeProviders(): string {
  const mark = (real: boolean) => (real ? "настоящий" : "демо");
  const engines = [
    config.gemini.apiKey && config.gemini.paidMedia && "Gemini",
    config.grok.apiKey && "Grok",
    config.higgsfield.keyId && config.higgsfield.keySecret && "Higgsfield",
    config.falKey && "fal.ai",
  ].filter(Boolean);
  return [
    `мозг: ${config.llm.provider === "claude" ? "Claude" : config.llm.provider === "gemini" ? "Gemini (бесплатно)" : "демо"}`,
    `кадры и видео: ${engines.length ? engines.join(", ") : "перекладка (бесплатно)"}`,
    `голос: ${config.tts.provider === "azure" ? "Azure" : config.tts.provider === "gemini" ? "Gemini TTS (бесплатно)" : "демо"}`,
    `Telegram: ${config.telegram.token ? "подключён" : "нет"}`,
    `Instagram: ${config.instagram.token ? "подключён" : "нет"}`,
  ].join(" · ");
}
