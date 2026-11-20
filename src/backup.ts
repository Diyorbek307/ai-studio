import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";

const run = promisify(execFile);

/**
 * Резервная копия студии в .tar.gz: клиенты, счета, заявки, журнал, отчёты, сериалы с картинками героев
 * и все эпизоды (сценарии, решения, статистика). Без full — без тяжёлых файлов: роликов, кадров, голосов.
 * Ключ подписи сессий в копию не попадает: после восстановления клиенты просто войдут заново.
 * Внимание: в копии есть ключи Instagram клиентов и хеши паролей — храните её так же бережно, как сервер.
 */
export async function makeBackup(out: string, opts: { full?: boolean } = {}): Promise<{ file: string; bytes: number }> {
  const data = path.resolve(config.dataDir);
  const series = path.resolve(config.seriesDir);
  const parts: string[] = [];
  if (fs.existsSync(data)) parts.push("-C", path.dirname(data), path.basename(data));
  // На Render сериалы лежат внутри диска с данными — второй раз не добавляем.
  if (fs.existsSync(series) && !series.startsWith(`${data}${path.sep}`)) parts.push("-C", path.dirname(series), path.basename(series));
  if (parts.length === 0) throw new Error("Нечего сохранять: папки данных и сериалов пусты");

  const excludes = ["--exclude=.session-secret", "--exclude=*.tmp", "--exclude=*.upload.png"];
  if (!opts.full) {
    excludes.push("--exclude=*/episodes/*/keyframes", "--exclude=*/episodes/*/clips", "--exclude=*/episodes/*/voice", "--exclude=*.mp4", "--exclude=*.wav", "--exclude=*.mp3");
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Архив не должен попасть сам в себя, если его кладут внутрь папки данных.
  excludes.push(`--exclude=${path.basename(out)}`);
  await run("tar", ["-czf", out, ...excludes, ...parts], { maxBuffer: 16 * 1024 * 1024 });
  return { file: out, bytes: fs.statSync(out).size };
}
