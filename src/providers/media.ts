import fs from "node:fs";
import path from "node:path";
import { download } from "./fal.js";

/** Результат движка: готовые байты или ссылка на файл, плюс сколько это стоило. */
export interface MediaResult {
  bytes?: Buffer;
  url?: string;
  costUsd: number;
}

/** Сохраняет результат движка в файл: пишет байты или скачивает по ссылке. */
export async function saveMedia(result: MediaResult, out: string): Promise<void> {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (result.bytes) fs.writeFileSync(out, result.bytes);
  else if (result.url) await download(result.url, out);
  else throw new Error("Движок не вернул файл");
}
