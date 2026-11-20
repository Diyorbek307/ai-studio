import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { normalizeImage, placeholderImage } from "../media/ffmpeg.js";
import { download, falRun, findFileUrl } from "./fal.js";

export interface ImageResult {
  costUsd: number;
}

const PALETTE = ["2d6a4f", "9d4edd", "e76f51", "264653", "c9184a", "3a86ff", "6a4c93", "bc6c25"];

/** Генерирует вертикальный кадр 1080×1920 по промпту и сохраняет в PNG. */
export async function generateImage(prompt: string, out: string, label: string, index: number): Promise<ImageResult> {
  fs.mkdirSync(path.dirname(out), { recursive: true });

  if (config.image.provider === "mock") {
    await placeholderImage(label, PALETTE[index % PALETTE.length]!, out);
    return { costUsd: 0 };
  }

  // Модели обычно рисуют размерами, кратными 16; рисуем 768×1344 и доводим до 1080×1920.
  const result = await falRun(config.image.falModel, {
    prompt,
    image_size: { width: 768, height: 1344 },
    num_images: 1,
    enable_safety_checker: true,
  });
  const url = findFileUrl(result, "image");
  if (!url) throw new Error(`fal.ai ${config.image.falModel}: в ответе нет картинки`);
  const raw = `${out}.raw`;
  await download(url, raw);
  try {
    await normalizeImage(raw, out);
  } finally {
    fs.rmSync(raw, { force: true });
  }
  return { costUsd: config.image.costUsd };
}
