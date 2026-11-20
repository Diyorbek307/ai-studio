import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { silence } from "../media/ffmpeg.js";
import type { Character } from "../types.js";

export interface SpeechResult {
  file: string;
  costUsd: number;
}

const LOCALE = { uz: "uz-UZ", ru: "ru-RU", en: "en-US" } as const;
const DEFAULT_VOICE = { uz: "uz-UZ-SardorNeural", ru: "ru-RU-DmitryNeural", en: "en-US-GuyNeural" } as const;

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Примерная длина реплики, если голоса нет: ~0,38 с на слово плюс пауза. */
export function estimateSpeechSeconds(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1.2, words * 0.38 + 0.4);
}

export function buildSsml(text: string, language: keyof typeof LOCALE, voice: Character["voice"]): string {
  const locale = LOCALE[language];
  const name = voice.azure ?? DEFAULT_VOICE[language];
  const rate = voice.rate ?? "+0%";
  const pitch = voice.pitch ?? "+0%";
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">` +
    `<voice name="${xmlEscape(name)}"><prosody rate="${xmlEscape(rate)}" pitch="${xmlEscape(pitch)}">` +
    `${xmlEscape(text)}</prosody></voice></speak>`
  );
}

/**
 * Озвучивает реплику голосом персонажа. Файл без расширения в outBase:
 * провайдер сам выбирает .mp3 (Azure) или .wav (демо).
 */
export async function speak(opts: {
  text: string;
  language: keyof typeof LOCALE;
  voice: Character["voice"];
  outBase: string;
}): Promise<SpeechResult> {
  fs.mkdirSync(path.dirname(opts.outBase), { recursive: true });

  if (config.tts.provider === "mock") {
    const file = `${opts.outBase}.wav`;
    await silence(estimateSpeechSeconds(opts.text), file);
    return { file, costUsd: 0 };
  }

  const res = await fetch(`https://${config.tts.azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": config.tts.azureKey,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
      "User-Agent": "ai-studio",
    },
    body: buildSsml(opts.text, opts.language, opts.voice),
  });
  if (!res.ok) throw new Error(`Azure TTS: ${res.status} ${await res.text()}`);
  const file = `${opts.outBase}.mp3`;
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return { file, costUsd: opts.text.length * config.tts.costPerCharUsd };
}
