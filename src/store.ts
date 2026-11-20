import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { type Episode, type Insights, type Series, SeriesSchema } from "./types.js";

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

// ---------- Эпизоды ----------

const EPISODE_ID = /^ep-\d{8}-[0-9a-f]{8}$/;

export function episodesDir(): string {
  return path.join(config.dataDir, "episodes");
}

export function episodeDir(id: string): string {
  if (!EPISODE_ID.test(id)) throw new Error(`Неверный id эпизода: ${id}`);
  return path.join(episodesDir(), id);
}

/** Абсолютный путь к файлу эпизода по относительному пути из episode.json. */
export function episodeFile(ep: Episode, relative: string): string {
  const dir = episodeDir(ep.id);
  const full = path.resolve(dir, relative);
  if (!full.startsWith(dir + path.sep)) throw new Error(`Путь вне папки эпизода: ${relative}`);
  return full;
}

export function newEpisodeId(now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `ep-${day}-${crypto.randomBytes(4).toString("hex")}`;
}

export function createEpisode(series: string): Episode {
  const now = new Date().toISOString();
  const ep: Episode = {
    id: newEpisodeId(),
    series,
    createdAt: now,
    updatedAt: now,
    status: "in_progress",
    feedback: [],
    attempts: {},
    costUsd: 0,
  };
  saveEpisode(ep);
  return ep;
}

export function saveEpisode(ep: Episode): void {
  ep.updatedAt = new Date().toISOString();
  writeJsonAtomic(path.join(episodeDir(ep.id), "episode.json"), ep);
}

export function loadEpisode(id: string): Episode {
  const ep = readJson<Episode>(path.join(episodeDir(id), "episode.json"));
  if (!ep) throw new Error(`Эпизод ${id} не найден`);
  return ep;
}

export function listEpisodes(): Episode[] {
  const dir = episodesDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => EPISODE_ID.test(name))
    .map((name) => readJson<Episode>(path.join(dir, name, "episode.json")))
    .filter((ep): ep is Episode => ep !== undefined)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---------- Сериалы ----------

/** Сериалы, которые лежат в коде (папка series/ проекта). */
export const BUNDLED_SERIES_DIR = path.resolve("series");

/**
 * На сервере библия сериала хранится на постоянном диске (STUDIO_SERIES_DIR),
 * чтобы канон внешности от Дизайнера персонажей не терялся при каждом деплое.
 * При первом запуске копируем туда сериалы из кода; существующие файлы не трогаем.
 */
export function seedSeries(): void {
  if (path.resolve(config.seriesDir) === BUNDLED_SERIES_DIR || !fs.existsSync(BUNDLED_SERIES_DIR)) return;
  fs.mkdirSync(config.seriesDir, { recursive: true });
  for (const file of fs.readdirSync(BUNDLED_SERIES_DIR).filter((f) => f.endsWith(".json"))) {
    const target = path.join(config.seriesDir, file);
    if (!fs.existsSync(target)) fs.copyFileSync(path.join(BUNDLED_SERIES_DIR, file), target);
  }
}

export function seriesFile(slug: string): string {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`Неверное имя сериала: ${slug}`);
  return path.join(config.seriesDir, `${slug}.json`);
}

export function loadSeries(slug: string): Series {
  const raw = readJson<unknown>(seriesFile(slug));
  if (!raw) throw new Error(`Сериал ${slug} не найден: нет файла ${seriesFile(slug)}`);
  return SeriesSchema.parse(raw);
}

export function saveSeries(series: Series): void {
  writeJsonAtomic(seriesFile(series.slug), series);
}

// ---------- Выводы аналитика ----------

export function loadInsights(slug: string): (Insights & { updatedAt: string }) | undefined {
  return readJson(path.join(config.dataDir, "insights", `${slug}.json`));
}

export function saveInsights(slug: string, insights: Insights): void {
  writeJsonAtomic(path.join(config.dataDir, "insights", `${slug}.json`), {
    ...insights,
    updatedAt: new Date().toISOString(),
  });
}

// ---------- Мелкое состояние студии ----------

interface StudioState {
  lastDailyRun?: string;
  telegramOffset?: number;
}

export function loadState(): StudioState {
  return readJson<StudioState>(path.join(config.dataDir, "state.json")) ?? {};
}

export function saveState(patch: Partial<StudioState>): void {
  writeJsonAtomic(path.join(config.dataDir, "state.json"), { ...loadState(), ...patch });
}
