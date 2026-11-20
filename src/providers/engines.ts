import { config } from "../config.js";

/** Движки, которые рисуют кадры и делают видео. */
export const ENGINES = ["cutout", "gemini", "grok", "higgsfield", "fal", "mock"] as const;
export type Engine = (typeof ENGINES)[number];
export type EngineChoice = Engine | "auto";

export const ENGINE_LABEL: Record<Engine, string> = {
  cutout: "Перекладка",
  gemini: "Gemini",
  grok: "Grok",
  higgsfield: "Higgsfield",
  fal: "fal.ai",
  mock: "Демо",
};

/** Бесплатные движки: работают на сервере студии, без внешних сервисов. */
export const FREE_ENGINES: Engine[] = ["cutout", "mock"];

/** Порядок, в котором «Авто» выбирает платный движок; если ни одного нет — бесплатная перекладка. */
const AUTO_ORDER: Engine[] = ["grok", "higgsfield", "gemini", "fal"];

export function isEngine(value: string): value is Engine {
  return (ENGINES as readonly string[]).includes(value);
}

export function engineAvailable(engine: Engine): boolean {
  switch (engine) {
    case "cutout":
    case "mock":
      return true;
    case "gemini":
      // Картинки и видео Gemini не входят в бесплатный тариф, поэтому включаются отдельно.
      return config.gemini.apiKey !== "" && config.gemini.paidMedia;
    case "grok":
      return config.grok.apiKey !== "";
    case "higgsfield":
      return config.higgsfield.keyId !== "" && config.higgsfield.keySecret !== "";
    case "fal":
      return config.falKey !== "";
  }
}

/**
 * Какой движок использовать: явный выбор для серии → настройка IMAGE_ENGINE / VIDEO_ENGINE →
 * первый подключённый платный → бесплатная перекладка. Явно выбранный, но не подключённый движок —
 * ошибка, а не тихая подмена.
 */
export function resolveEngine(choice: EngineChoice | undefined, kind: "image" | "video"): Engine {
  const fromConfig = kind === "image" ? config.image.engine : config.video.engine;
  const pick = choice && choice !== "auto" ? choice : fromConfig;
  if (pick !== "auto") {
    if (!engineAvailable(pick)) {
      const hint = pick === "gemini" && config.gemini.apiKey ? " (картинки и видео Gemini платные — включи GEMINI_MEDIA=on)" : ": добавь ключ в настройках";
      throw new Error(`${ENGINE_LABEL[pick]} не подключён${hint}`);
    }
    return pick;
  }
  return AUTO_ORDER.find(engineAvailable) ?? "cutout";
}

export function engineStatus(): { engine: Engine; label: string; available: boolean; free: boolean }[] {
  return ENGINES.filter((e) => e !== "mock").map((engine) => ({
    engine,
    label: ENGINE_LABEL[engine],
    available: engineAvailable(engine),
    free: FREE_ENGINES.includes(engine),
  }));
}
