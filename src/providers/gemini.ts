import { config } from "../config.js";
import type { MediaResult } from "./media.js";

/**
 * Gemini API, Interactions (aistudio.google.com/docs/omni и /docs/image-generation).
 * Картинки — Nano Banana 2.1, видео — Gemini Omni Flash (Veo 3.1 Preview отключён 22.10.2026).
 * Ответ синхронный: готовый файл приходит в base64 внутри steps[] → model_output → content[].
 */
const URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

interface InteractionResponse {
  status?: string;
  steps?: { type: string; content?: { type: string; data?: string; mime_type?: string }[] }[];
  error?: { message?: string };
}

async function interact(body: unknown, timeoutMs: number, revision: boolean): Promise<InteractionResponse> {
  const headers: Record<string, string> = { "x-goog-api-key": config.gemini.apiKey, "Content-Type": "application/json" };
  if (revision && config.gemini.apiRevision) headers["Api-Revision"] = config.gemini.apiRevision;
  const res = await fetch(URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let data: InteractionResponse | InteractionResponse[];
  try {
    data = JSON.parse(text) as InteractionResponse | InteractionResponse[];
  } catch {
    throw new Error(`Gemini: ${res.status} ${text.slice(0, 300)}`);
  }
  // Ошибки Google иногда приходят массивом: [{ "error": { ... } }].
  const one = Array.isArray(data) ? data[0] : data;
  if (!res.ok || !one) throw new Error(`Gemini: ${res.status} ${one?.error?.message ?? text.slice(0, 300)}`);
  return one;
}

/** Первый блок нужного типа из ответа модели. */
export function modelOutput(data: InteractionResponse, type: "image" | "video"): Buffer {
  for (const step of data.steps ?? []) {
    if (step.type !== "model_output") continue;
    const block = step.content?.find((c) => c.type === type && c.data);
    if (block?.data) return Buffer.from(block.data, "base64");
  }
  throw new Error(`Gemini: в ответе нет ${type === "image" ? "картинки" : "видео"} (статус: ${data.status ?? "неизвестен"})`);
}

export async function geminiImage(prompt: string): Promise<MediaResult> {
  const data = await interact(
    {
      model: config.gemini.imageModel,
      input: prompt,
      response_format: { type: "image", mime_type: "image/png", aspect_ratio: "9:16" },
    },
    5 * 60_000,
    true,
  );
  return { bytes: modelOutput(data, "image"), costUsd: config.gemini.imageCostUsd };
}

export async function geminiVideo(opts: { imageBase64: string; prompt: string; seconds: number }): Promise<MediaResult> {
  const seconds = Math.min(15, Math.max(3, Math.round(opts.seconds)));
  const data = await interact(
    {
      model: config.gemini.videoModel,
      input: [
        { type: "image", data: opts.imageBase64, mime_type: "image/png" },
        {
          type: "text",
          text: `${opts.prompt}. Start exactly from this frame and keep every character's look unchanged. No text, captions or subtitles on screen.`,
        },
      ],
      response_format: { type: "video", aspect_ratio: "9:16", duration: `${seconds}s` },
    },
    15 * 60_000,
    false,
  );
  return { bytes: modelOutput(data, "video"), costUsd: seconds * config.gemini.videoCostPerSecUsd };
}
