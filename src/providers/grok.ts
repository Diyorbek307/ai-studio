import { config } from "../config.js";
import type { MediaResult } from "./media.js";

/**
 * xAI Grok Imagine (docs.x.ai, REST reference «Images» и «Videos»).
 * Картинка: POST /v1/images/generations. Видео: POST /v1/videos/generations → опрос GET /v1/videos/{request_id}.
 * Стоимость берём из ответа: usage.cost_in_usd_ticks, 1 доллар = 10 000 000 000 тиков.
 */
const BASE = "https://api.x.ai/v1";
const TICKS_PER_USD = 10_000_000_000;

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${config.grok.apiKey}`, "Content-Type": "application/json" };
}

function usd(usage: { cost_in_usd_ticks?: number } | undefined): number {
  return usage?.cost_in_usd_ticks ? usage.cost_in_usd_ticks / TICKS_PER_USD : 0;
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`Grok ${what}: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

export async function grokImage(prompt: string): Promise<MediaResult> {
  const res = await fetch(`${BASE}/images/generations`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: config.grok.imageModel,
      prompt,
      n: 1,
      aspect_ratio: "9:16",
      response_format: "b64_json",
    }),
    signal: AbortSignal.timeout(5 * 60_000),
  });
  const data = await readJson<{ data: { b64_json?: string | null; url?: string | null }[]; usage?: { cost_in_usd_ticks?: number } }>(
    res,
    "картинка",
  );
  const first = data.data[0];
  if (first?.b64_json) return { bytes: Buffer.from(first.b64_json, "base64"), costUsd: usd(data.usage) };
  if (first?.url) return { url: first.url, costUsd: usd(data.usage) };
  throw new Error("Grok: в ответе нет картинки");
}

export async function grokVideo(opts: { imageDataUri: string; prompt: string; seconds: number }): Promise<MediaResult> {
  const start = await fetch(`${BASE}/videos/generations`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: config.grok.videoModel,
      prompt: opts.prompt,
      image: { url: opts.imageDataUri },
      duration: Math.min(15, Math.max(1, Math.round(opts.seconds))),
      aspect_ratio: "9:16",
      resolution: config.grok.videoResolution,
      // Голоса героев студия делает сама, поэтому просим видео без звука.
      generate_audio: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const { request_id } = await readJson<{ request_id: string }>(start, "видео");

  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("Grok: видео не готово за 15 минут");
    await new Promise((r) => setTimeout(r, config.pollMs));
    const poll = await fetch(`${BASE}/videos/${request_id}`, { headers: headers(), signal: AbortSignal.timeout(60_000) });
    const body = await readJson<{
      status: string;
      error?: { code: string; message: string };
      video?: { url?: string | null; respect_moderation?: boolean };
      usage?: { cost_in_usd_ticks?: number };
    }>(poll, "статус видео");
    if (body.status === "failed") throw new Error(`Grok: видео не получилось — ${body.error?.message ?? "без пояснения"}`);
    if (body.status === "done") {
      if (body.video?.respect_moderation === false || !body.video?.url) {
        throw new Error("Grok: видео не прошло модерацию — измени описание кадра");
      }
      return { url: body.video.url, costUsd: usd(body.usage) };
    }
  }
}
