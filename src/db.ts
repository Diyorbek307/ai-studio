import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Простое хранилище коллекций в JSON-файлах (data/<name>.json).
 * Студия работает в одном процессе, а запись синхронная и атомарная (через временный файл),
 * поэтому одновременные записи не перемешиваются.
 */
function file(name: string): string {
  if (!/^[a-z-]+$/.test(name)) throw new Error(`Неверное имя коллекции: ${name}`);
  return path.join(config.dataDir, `${name}.json`);
}

export function readCollection<T>(name: string): T[] {
  const f = file(name);
  if (!fs.existsSync(f)) return [];
  const data = JSON.parse(fs.readFileSync(f, "utf8")) as { items?: T[] };
  return data.items ?? [];
}

export function writeCollection<T>(name: string, items: T[]): void {
  const f = file(name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, f);
}

/** Добавляет строку в журнал data/<name>.jsonl. */
export function appendLine(name: string, value: unknown): void {
  if (!/^[a-z-]+$/.test(name)) throw new Error(`Неверное имя журнала: ${name}`);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.appendFileSync(path.join(config.dataDir, `${name}.jsonl`), JSON.stringify(value) + "\n", { mode: 0o600 });
}

/** Последние строки журнала, новые сверху. */
export function readLines<T>(name: string, limit = 100): T[] {
  const f = path.join(config.dataDir, `${name}.jsonl`);
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-limit)
    .reverse()
    .map((l) => JSON.parse(l) as T);
}
