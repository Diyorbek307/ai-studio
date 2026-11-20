import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Изолирует тест: временная папка данных и все внешние сервисы в демо-режиме.
 * Вызывать до импорта модулей студии — конфиг читается при импорте.
 * Явно заданные пустые значения не перезапишутся из .env, так что тесты никогда не тратят деньги.
 */
export function isolate(extra: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-studio-test-"));
  Object.assign(process.env, {
    STUDIO_DATA_DIR: dir,
    STUDIO_MUSIC_DIR: path.join(dir, "no-music"),
    LLM_PROVIDER: "mock",
    IMAGE_PROVIDER: "mock",
    VIDEO_PROVIDER: "mock",
    TTS_PROVIDER: "mock",
    ANTHROPIC_API_KEY: "",
    FAL_KEY: "",
    AZURE_SPEECH_KEY: "",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_ADMIN_CHAT_ID: "",
    IG_USER_ID: "",
    IG_ACCESS_TOKEN: "",
    PUBLIC_BASE_URL: "",
    DAILY_BUDGET_USD: "5",
    DAILY_AT: "",
    ...extra,
  });
  return dir;
}
