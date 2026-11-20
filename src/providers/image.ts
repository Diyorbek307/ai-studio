import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { normalizeImage, placeholderImage } from "../media/ffmpeg.js";
import type { Engine } from "./engines.js";
import { falRun, findFileUrl } from "./fal.js";
import { geminiImage, type ImageReference } from "./gemini.js";
import { grokImage } from "./grok.js";
import { higgsfieldImage, type SoulReference } from "./higgsfield.js";
import { type MediaResult, saveMedia } from "./media.js";

export interface ImageResult {
  costUsd: number;
}

const PALETTE = ["2d6a4f", "9d4edd", "e76f51", "264653", "c9184a", "3a86ff", "6a4c93", "bc6c25"];

async function falImage(prompt: string): Promise<MediaResult> {
  // Модели обычно рисуют размерами, кратными 16; рисуем 768×1344 и доводим до 1080×1920.
  const result = await falRun(config.image.falModel, {
    prompt,
    image_size: { width: 768, height: 1344 },
    num_images: 1,
    enable_safety_checker: true,
  });
  const url = findFileUrl(result, "image");
  if (!url) throw new Error(`fal.ai ${config.image.falModel}: в ответе нет картинки`);
  return { url, costUsd: config.image.costUsd };
}

/** Рисует вертикальный кадр 1080×1920 выбранным движком и сохраняет в PNG. */
export async function generateImage(opts: {
  prompt: string;
  out: string;
  label: string;
  index: number;
  engine: Engine;
  /** Картинки героев и места сцены — для Gemini и Grok. */
  references?: ImageReference[];
  /** Обученный герой сцены — для Higgsfield SOUL. */
  soul?: SoulReference;
}): Promise<ImageResult> {
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });

  if (opts.engine === "mock") {
    await placeholderImage(opts.label, PALETTE[opts.index % PALETTE.length]!, opts.out);
    return { costUsd: 0 };
  }

  const result =
    opts.engine === "gemini"
      ? await geminiImage(opts.prompt, opts.references)
      : opts.engine === "grok"
        ? await grokImage(opts.prompt, opts.references)
        : opts.engine === "higgsfield"
          ? await higgsfieldImage(opts.prompt, opts.soul)
          : await falImage(opts.prompt);

  const raw = `${opts.out}.raw`;
  await saveMedia(result, raw);
  try {
    await normalizeImage(raw, opts.out);
  } finally {
    fs.rmSync(raw, { force: true });
  }
  return { costUsd: result.costUsd };
}
