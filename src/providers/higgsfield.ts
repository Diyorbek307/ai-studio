import crypto from "node:crypto";
import fs from "node:fs";
import { config } from "../config.js";
import type { MediaResult } from "./media.js";

/**
 * Higgsfield API (docs.higgsfield.ai). Запрос → request_id и status_url → опрос до completed.
 * Модели принимают только публичные ссылки на файлы, поэтому кадр сначала загружаем
 * через POST /files/generate-upload-url и PUT по выданной ссылке.
 */
const BASE = "https://api.higgsfield.ai";
const TERMINAL_FAIL = new Set(["failed", "nsfw", "canceled"]);

function auth(): Record<string, string> {
  return { Authorization: `Key ${config.higgsfield.keyId}:${config.higgsfield.keySecret}` };
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`Higgsfield ${what}: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

interface StatusBody {
  status: string;
  error?: unknown;
  images?: { url: string }[];
  video?: { url: string };
}

async function run(endpoint: string, body: Record<string, unknown>): Promise<StatusBody> {
  const submit = await fetch(`${BASE}/${endpoint}`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const job = await readJson<{ request_id: string; status_url?: string }>(submit, endpoint);
  const statusUrl = job.status_url ?? `${BASE}/requests/${job.request_id}/status`;

  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("Higgsfield: результат не готов за 15 минут");
    await new Promise((r) => setTimeout(r, config.pollMs));
    const status = await readJson<StatusBody>(await fetch(statusUrl, { headers: auth(), signal: AbortSignal.timeout(60_000) }), "статус");
    if (status.status === "completed") return status;
    if (TERMINAL_FAIL.has(status.status)) {
      const why = status.status === "nsfw" ? "отклонено модерацией" : status.status === "canceled" ? "отменено" : JSON.stringify(status.error ?? "ошибка");
      throw new Error(`Higgsfield: ${why}`);
    }
  }
}

/** Загружает локальный файл в хранилище Higgsfield и возвращает его публичную ссылку. */
async function upload(file: string, contentType: string): Promise<string> {
  const res = await fetch(`${BASE}/files/generate-upload-url`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({ content_type: contentType }),
    signal: AbortSignal.timeout(60_000),
  });
  const slot = await readJson<{ public_url: string; upload_url: string; upload_headers?: Record<string, string> }>(res, "загрузка");
  // Ключи Higgsfield в хранилище не отправляем — только выданные заголовки.
  const put = await fetch(slot.upload_url, {
    method: "PUT",
    headers: slot.upload_headers ?? { "Content-Type": contentType },
    body: fs.readFileSync(file),
    signal: AbortSignal.timeout(5 * 60_000),
  });
  if (!put.ok) throw new Error(`Higgsfield: файл не загрузился (${put.status})`);
  return slot.public_url;
}

export async function higgsfieldImage(prompt: string): Promise<MediaResult> {
  const out = await run(config.higgsfield.imageEndpoint, { prompt, aspect_ratio: "9:16", resolution: "1080p", batch_size: 1 });
  const url = out.images?.[0]?.url;
  if (!url) throw new Error("Higgsfield: в ответе нет картинки");
  return { url, costUsd: config.higgsfield.imageCostUsd };
}

export async function higgsfieldVideo(opts: { image: string; imageUrl?: string; prompt: string; seconds: number }): Promise<MediaResult> {
  const duration = Math.min(15, Math.max(3, Math.round(opts.seconds)));
  const imageUrl = opts.imageUrl ?? (await upload(opts.image, "image/png"));
  const out = await run(config.higgsfield.videoEndpoint, { prompt: opts.prompt, image_url: imageUrl, duration, sound: "off" });
  if (!out.video?.url) throw new Error("Higgsfield: в ответе нет видео");
  return { url: out.video.url, costUsd: duration * config.higgsfield.videoCostPerSecUsd };
}
