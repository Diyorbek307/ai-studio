import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { kenBurns } from "../media/ffmpeg.js";
import { dataUri, download, falRun, findFileUrl } from "./fal.js";

export interface VideoResult {
  costUsd: number;
}

/**
 * Оживляет ключевой кадр в клип. Длину потом подгоняет монтажёр,
 * поэтому здесь берём ближайшую длину, которую умеет модель (5 или 10 секунд).
 */
export async function animateImage(opts: {
  image: string;
  /** Публичная ссылка на кадр, если сервер доступен из интернета. */
  imageUrl?: string;
  motionPrompt: string;
  seconds: number;
  out: string;
}): Promise<VideoResult> {
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });

  if (config.video.provider === "mock") {
    await kenBurns(opts.image, opts.seconds, opts.out);
    return { costUsd: 0 };
  }

  const duration = opts.seconds > 6 ? 10 : 5;
  const result = await falRun(config.video.falModel, {
    prompt: opts.motionPrompt,
    image_url: opts.imageUrl ?? dataUri(opts.image, "image/png"),
    duration: String(duration),
    aspect_ratio: "9:16",
    negative_prompt: "blur, distortion, extra limbs, extra fingers, deformed face, text, watermark, logo",
  });
  const url = findFileUrl(result, "video");
  if (!url) throw new Error(`fal.ai ${config.video.falModel}: в ответе нет видео`);
  await download(url, opts.out);
  return { costUsd: duration * config.video.costPerSecUsd };
}
