import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { Series } from "../types.js";
import { characterAsset, isPlaceholder } from "./cutout.js";
import { ffmpeg } from "./ffmpeg.js";

/** Длина фирменной концовки, секунды. */
export const END_CARD_SECONDS = 2.2;

export interface EndCard {
  title: string;
  slogan?: string;
  cta?: string;
  color: string;
}

/**
 * Фирменная концовка серии: у брендов клиентов включена по умолчанию (название компании и что она продаёт),
 * у собственного сериала студии — только если задана в библии сериала. end_card.enabled = false выключает.
 */
export function endCardFor(series: Series): EndCard | undefined {
  const cfg = series.end_card;
  if (cfg?.enabled === false) return undefined;
  if (!cfg && !series.client) return undefined;
  const title = cfg?.title?.trim() || series.client?.company || series.title;
  return {
    title,
    slogan: cfg?.slogan?.trim() || series.client?.product || undefined,
    cta: cfg?.cta?.trim() || undefined,
    color: cfg?.color || series.characters[0]?.color || "#0B6E8E",
  };
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "").padEnd(6, "0");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Текст для drawtext через файл: так не нужно экранировать кавычки и двоеточия в названиях компаний. */
const BOLD_FONTS = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"];

function text(file: string, value: string, size: number, y: string, delay: number, bold = false): string {
  fs.writeFileSync(file, value);
  const safe = file.replace(/\\/g, "/").replace(/'/g, "");
  const boldFile = bold ? BOLD_FONTS.find((f) => fs.existsSync(f)) : undefined;
  return `drawtext=textfile='${safe}'${boldFile ? `:fontfile='${boldFile}'` : ""}:fontcolor=white:fontsize=${size}:x=(w-text_w)/2:y=${y}:shadowcolor=black@0.35:shadowx=0:shadowy=4:alpha='min(1,max(0,(t-${delay})/0.35))'`;
}

/** Разбивает строку на строки не длиннее max символов (по словам), не больше limit строк. */
function lines(value: string, max: number, limit: number): string[] {
  // «@instagram · +998 …» — каждая часть своей строкой, а не перенос посреди телефона.
  const parts = value.split(/\s*[·|]\s*/).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => p.length <= max)) return parts.slice(0, limit);
  const out: string[] = [];
  let current = "";
  for (const word of value.split(/\s+/).filter(Boolean)) {
    if (current && (current + " " + word).length > max) {
      out.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) out.push(current);
  return out.slice(0, limit);
}

/**
 * Рисует концовку: фон цвета бренда, маскот подпрыгивает снизу, сверху проявляются название, слоган и контакт.
 * Без шрифтов в сборке ffmpeg — просто фон с маскотом.
 */
export async function renderEndCard(series: Series, card: EndCard, out: string, seconds = END_CARD_SECONDS): Promise<void> {
  const { width: W, height: H, fps } = config.render;
  const work = path.join(path.dirname(out), "endcard");
  fs.mkdirSync(work, { recursive: true });

  // Фон один раз картинкой (geq медленный), потом зацикливаем.
  const [r, g, b] = rgb(card.color);
  const dark = (c: number) => Math.round(c * 0.55);
  const bg = path.join(work, "bg.png");
  const mix = (a: number, z: number) => `'${a}+(${z}-${a})*(Y/H)'`;
  await ffmpeg(["-f", "lavfi", "-i", `color=c=black:s=${W}x${H}`, "-vf", `format=rgb24,geq=r=${mix(r, dark(r))}:g=${mix(g, dark(g))}:b=${mix(b, dark(b))}`, "-frames:v", "1", bg]);

  const mascotId = series.characters.find((c) => {
    const f = characterAsset(series.slug, c.id);
    return fs.existsSync(f) && !isPlaceholder(f);
  })?.id;
  const args = ["-loop", "1", "-framerate", String(fps), "-i", bg];
  if (mascotId) args.push("-loop", "1", "-framerate", String(fps), "-i", characterAsset(series.slug, mascotId));

  // Каждая строка — отдельная надпись по центру: выравнивание строк внутри drawtext есть не во всех сборках ffmpeg.
  const texts: string[] = [];
  let y = 400;
  let n = 0;
  const block = (value: string | undefined, size: number, max: number, limit: number, delay: number, gapAfter: number, bold = false) => {
    if (!value) return;
    for (const line of lines(value, max, limit)) {
      texts.push(text(path.join(work, `t${n++}.txt`), line, size, String(y), delay, bold));
      y += Math.round(size * 1.22);
    }
    y += gapAfter;
  };
  block(card.title, 100, 15, 2, 0.1, 40, true);
  block(card.slogan, 46, 30, 2, 0.35, 34);
  block(card.cta, 44, 30, 2, 0.6, 0);

  const base = mascotId
    ? `[1:v]format=rgba,scale=-2:820[m];[0:v][m]overlay=x=(W-w)/2:y='H-120-h-18*abs(sin(t*5))':eval=frame`
    : "[0:v]null";
  const tail = `fps=${fps},format=yuv420p,setsar=1[out]`;
  const encode = ["-map", "[out]", "-t", seconds.toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-an", out];
  try {
    await ffmpeg([...args, "-filter_complex", `${base},${texts.join(",")},${tail}`, ...encode]);
  } catch {
    await ffmpeg([...args, "-filter_complex", `${base},${tail}`, ...encode]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
