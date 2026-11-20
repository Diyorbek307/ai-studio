import fs from "node:fs";
import path from "node:path";
import { UI_FILE } from "./server.js";
import { episodeDir, listEpisodes } from "./store.js";
import { buildStudioState } from "./studioState.js";

/**
 * Превью интерфейса без сервера: ui/app.html + снимок данных студии + файлы роликов рядом.
 * Кнопки в превью ничего не меняют — интерфейс сам показывает об этом плашку.
 */
export function buildPreview(outDir: string): { page: string; media: string[] } {
  const media: string[] = [];
  const state = buildStudioState({
    episodes: listEpisodes(),
    mediaUrl: (ep, file) => {
      const rel = `media/${ep.id}/${file}`;
      const target = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(episodeDir(ep.id), file), target);
      media.push(rel);
      return rel;
    },
  });

  const data = JSON.stringify(state).replace(/</g, "\\u003c");
  const ui = fs.readFileSync(UI_FILE, "utf8");
  const at = ui.lastIndexOf("<script>");
  if (at === -1) throw new Error("В ui/app.html нет основного скрипта");
  const page = `${ui.slice(0, at)}<script>window.STUDIO_PREVIEW = ${data};</script>\n${ui.slice(at)}`;

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "index.html");
  fs.writeFileSync(file, page);
  return { page: file, media };
}
