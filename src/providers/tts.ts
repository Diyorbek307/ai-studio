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

const FEMALE_AZURE = { uz: "uz-UZ-MadinaNeural", ru: "ru-RU-SvetlanaNeural", en: "en-US-JennyNeural" } as const;
const FEMALE_NAMES = /Madina|Svetlana|Dariya|Jenny|Aria|Sara|Ava|Emma|Michelle/i;

/**
 * Голос героя для другого языка (русская версия серии): Azure-голос подбирается того же пола
 * под нужный язык, темп и высота сохраняются. Голос Gemini подходит для всех языков и не меняется.
 */
export function voiceForLanguage(voice: Character["voice"], language: keyof typeof LOCALE): Character["voice"] {
  if (!voice.azure || voice.azure.startsWith(LOCALE[language])) return voice;
  const female = FEMALE_NAMES.test(voice.azure);
  return { ...voice, azure: female ? FEMALE_AZURE[language] : DEFAULT_VOICE[language] };
}

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
 * Gemini TTS (aistudio.google.com/docs/speech-generation): generateContent с responseModalities AUDIO.
 * Модели 3.8 возвращают готовый WAV (24 кГц, моно) в candidates[0].content.parts[0].inlineData.data.
 * Узбекский (Northern Uzbek) и русский есть в списке языков; язык модель берёт из текста.
 */
export async function geminiSpeech(text: string, voice: Character["voice"], emotion?: string): Promise<Buffer> {
  const style = [emotion, voice.style].filter(Boolean).join("; ");
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.tts.geminiModel}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": config.gemini.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text, ...(style ? { speech_metadata: { style } } : {}) }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { voice: voice.gemini ?? "Kore" } },
      },
    }),
    signal: AbortSignal.timeout(2 * 60_000),
  });
  const raw = await res.text();
  let data: { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[]; error?: { message?: string } } | undefined;
  try {
    const parsed = JSON.parse(raw) as typeof data | (typeof data)[];
    data = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    throw new Error(`Gemini TTS: ${res.status} ${raw.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`Gemini TTS: ${res.status} ${data?.error?.message ?? raw.slice(0, 300)}`);
  const audio = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
  if (!audio) throw new Error("Gemini TTS: в ответе нет звука");
  return Buffer.from(audio, "base64");
}

/**
 * Озвучивает реплику голосом персонажа. Файл без расширения в outBase:
 * провайдер сам выбирает .mp3 (Azure) или .wav (Gemini, демо).
 */
export async function speak(opts: {
  text: string;
  language: keyof typeof LOCALE;
  voice: Character["voice"];
  /** Эмоция реплики из сценария — Gemini TTS играет её голосом. */
  emotion?: string;
  outBase: string;
}): Promise<SpeechResult> {
  fs.mkdirSync(path.dirname(opts.outBase), { recursive: true });

  if (config.tts.provider === "mock") {
    const file = `${opts.outBase}.wav`;
    await silence(estimateSpeechSeconds(opts.text), file);
    return { file, costUsd: 0 };
  }

  if (config.tts.provider === "gemini") {
    const file = `${opts.outBase}.wav`;
    fs.writeFileSync(file, await geminiSpeech(opts.text, opts.voice, opts.emotion));
    return { file, costUsd: opts.text.length * config.tts.geminiCostPerCharUsd };
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
