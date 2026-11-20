import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { kenBurns } from "../media/ffmpeg.js";
import type { Engine } from "./engines.js";
import { dataUri, falRun, findFileUrl } from "./fal.js";
import { geminiVideo } from "./gemini.js";
import { grokVideo } from "./grok.js";
import { higgsfieldVideo } from "./higgsfield.js";
import { type MediaResult, saveMedia } from "./media.js";

export interface VideoResult {
  costUsd: number;
}

async function falVideo(opts: { image: string; imageUrl?: string; motionPrompt: string; seconds: number }): Promise<MediaResult> {
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
  return { url, costUsd: duration * config.video.costPerSecUsd };
}

/**
 * Оживляет ключевой кадр в клип выбранным движком. Длину точно подгоняет монтажёр,
 * поэтому здесь просим ближайшую длину, которую умеет движок.
 */
export async function animateImage(opts: {
  image: string;
  /** Публичная ссылка на кадр, если сервер доступен из интернета. */
  imageUrl?: string;
  motionPrompt: string;
  seconds: number;
  out: string;
  engine: Engine;
}): Promise<VideoResult> {
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });

  if (opts.engine === "mock") {
    await kenBurns(opts.image, opts.seconds, opts.out);
    return { costUsd: 0 };
  }

  const result =
    opts.engine === "gemini"
      ? await geminiVideo({ imageBase64: fs.readFileSync(opts.image).toString("base64"), prompt: opts.motionPrompt, seconds: opts.seconds })
      : opts.engine === "grok"
        ? await grokVideo({ imageDataUri: dataUri(opts.image, "image/png"), prompt: opts.motionPrompt, seconds: opts.seconds })
        : opts.engine === "higgsfield"
          ? await higgsfieldVideo({ image: opts.image, imageUrl: opts.imageUrl, prompt: opts.motionPrompt, seconds: opts.seconds })
          : await falVideo(opts);

  await saveMedia(result, opts.out);
  return { costUsd: result.costUsd };
}
