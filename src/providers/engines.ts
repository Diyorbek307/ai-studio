import { config } from "../config.js";

/** Движки, которые рисуют кадры и делают видео. */
export const ENGINES = ["gemini", "grok", "higgsfield", "fal", "mock"] as const;
export type Engine = (typeof ENGINES)[number];
export type EngineChoice = Engine | "auto";

export const ENGINE_LABEL: Record<Engine, string> = {
  gemini: "Gemini",
  grok: "Grok",
  higgsfield: "Higgsfield",
  fal: "fal.ai",
  mock: "Демо",
};

/** Порядок, в котором «Авто» выбирает движок из подключённых. */
const AUTO_ORDER: Engine[] = ["gemini", "grok", "higgsfield", "fal"];

export function isEngine(value: string): value is Engine {
  return (ENGINES as readonly string[]).includes(value);
}

export function engineAvailable(engine: Engine): boolean {
  switch (engine) {
    case "gemini":
      return config.gemini.apiKey !== "";
    case "grok":
      return config.grok.apiKey !== "";
    case "higgsfield":
      return config.higgsfield.keyId !== "" && config.higgsfield.keySecret !== "";
    case "fal":
      return config.falKey !== "";
    case "mock":
      return true;
  }
}

/**
 * Какой движок использовать: явный выбор для серии → настройка IMAGE_ENGINE / VIDEO_ENGINE →
 * первый подключённый → демо. Явно выбранный, но не подключённый движок — ошибка, а не тихая подмена.
 */
export function resolveEngine(choice: EngineChoice | undefined, kind: "image" | "video"): Engine {
  const fromConfig = kind === "image" ? config.image.engine : config.video.engine;
  const pick = choice && choice !== "auto" ? choice : fromConfig;
  if (pick !== "auto") {
    if (!engineAvailable(pick)) throw new Error(`${ENGINE_LABEL[pick]} не подключён: добавь ключ в настройках`);
    return pick;
  }
  return AUTO_ORDER.find(engineAvailable) ?? "mock";
}

export function engineStatus(): { engine: Engine; label: string; available: boolean }[] {
  return ENGINES.filter((e) => e !== "mock").map((engine) => ({ engine, label: ENGINE_LABEL[engine], available: engineAvailable(engine) }));
}
