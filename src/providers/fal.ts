import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/**
 * Очередь fal.ai: отправляем задачу, ждём готовности, забираем результат.
 * Модель задаётся строкой (FAL_IMAGE_MODEL / FAL_VIDEO_MODEL), так что её можно менять без кода.
 */
export async function falRun(model: string, input: Record<string, unknown>, timeoutMs = 10 * 60_000): Promise<unknown> {
  if (!config.falKey) throw new Error("FAL_KEY не задан");
  const headers = { Authorization: `Key ${config.falKey}`, "Content-Type": "application/json" };

  const submit = await fetch(`https://queue.fal.run/${model}`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  if (!submit.ok) throw new Error(`fal.ai ${model}: ${submit.status} ${await submit.text()}`);
  const job = (await submit.json()) as { status_url?: string; response_url?: string; request_id?: string };
  if (!job.status_url || !job.response_url) throw new Error(`fal.ai ${model}: неожиданный ответ очереди`);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`fal.ai ${model}: не дождались результата за ${timeoutMs / 1000} с`);
    await new Promise((r) => setTimeout(r, 3000));
    const status = await fetch(job.status_url, { headers });
    if (!status.ok) throw new Error(`fal.ai статус: ${status.status} ${await status.text()}`);
    const body = (await status.json()) as { status?: string };
    if (body.status === "COMPLETED") break;
    if (body.status && !["IN_QUEUE", "IN_PROGRESS"].includes(body.status)) {
      throw new Error(`fal.ai ${model}: задача завершилась со статусом ${body.status}`);
    }
  }

  const result = await fetch(job.response_url, { headers });
  if (!result.ok) throw new Error(`fal.ai результат: ${result.status} ${await result.text()}`);
  return result.json();
}

const EXTENSIONS = {
  image: [".png", ".jpg", ".jpeg", ".webp"],
  video: [".mp4", ".mov", ".webm"],
};

function isHttp(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//.test(value);
}

function hasExtension(url: string, kind: "image" | "video"): boolean {
  const clean = url.split("?")[0]!.toLowerCase();
  return EXTENSIONS[kind].some((ext) => clean.endsWith(ext));
}

/**
 * Ищет в ответе модели первую ссылку на картинку или видео.
 * Чаще всего это { images: [{ url }] } или { video: { url } }, но у моделей бывают разные формы ответа.
 */
export function findFileUrl(value: unknown, kind: "image" | "video"): string | undefined {
  if (isHttp(value)) return hasExtension(value, kind) ? value : undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFileUrl(item, kind);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const contentType = typeof obj.content_type === "string" ? obj.content_type : "";
    if (isHttp(obj.url) && (contentType.startsWith(`${kind}/`) || hasExtension(obj.url, kind))) {
      return obj.url;
    }
    for (const nested of Object.values(obj)) {
      const found = findFileUrl(nested, kind);
      if (found) return found;
    }
  }
  return undefined;
}

export async function download(url: string, out: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не удалось скачать ${url}: ${res.status}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
}

export function dataUri(file: string, mime: string): string {
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}
