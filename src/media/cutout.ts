import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { Scene, Series } from "../types.js";
import { ffmpeg, pixelFormat, probe } from "./ffmpeg.js";

/**
 * «Перекладка» — бесплатная анимация из готовых картинок, как в мультсериалах-аппликациях:
 * фон локации + вырезанные персонажи. Говорящий герой подпрыгивает в такт реплике,
 * остальные слегка покачиваются, камера медленно едет. Внешность героев одна и та же
 * в каждой серии, потому что это одни и те же картинки.
 *
 * Картинки лежат в series/assets/<сериал>/characters/<id>.png и locations/<id>.png.
 * Если картинки нет, студия рисует заглушку, а ты заменяешь её во вкладке «Бренды».
 */

const W = config.render.width;
const H = config.render.height;
// Холст чуть больше кадра: камере есть куда ехать.
const CW = Math.round(W * 1.1);
const CH = Math.round(H * 1.1);
const FEET_FROM_BOTTOM = 430;

export function assetsDir(slug: string): string {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`Неверное имя сериала: ${slug}`);
  return path.join(config.seriesDir, "assets", slug);
}

/** Необязательные состояния героя для живой перекладки: рот открыт и глаза закрыты. */
export const CHARACTER_VARIANTS = ["talk", "blink"] as const;
export type CharacterVariant = (typeof CHARACTER_VARIANTS)[number];

export function isCharacterVariant(value: string | null | undefined): value is CharacterVariant {
  return (CHARACTER_VARIANTS as readonly string[]).includes(value ?? "");
}

/** Картинка героя: основная (<id>.png) или состояние (<id>.talk.png, <id>.blink.png). */
export function characterAsset(slug: string, id: string, variant?: CharacterVariant): string {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Неверный id героя: ${id}`);
  return path.join(assetsDir(slug), "characters", variant ? `${id}.${variant}.png` : `${id}.png`);
}

export function locationAsset(slug: string, id: string): string {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Неверный id локации: ${id}`);
  return path.join(assetsDir(slug), "locations", `${id}.png`);
}

/** Есть ли настоящая картинка (не заглушка) — заглушки помечены файлом-соседом .placeholder. */
export function isPlaceholder(file: string): boolean {
  return fs.existsSync(`${file}.placeholder`);
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "").padEnd(6, "0");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function textFilter(textFile: string, size: number, y: string, color = "white"): string {
  const safe = textFile.replace(/\\/g, "/").replace(/'/g, "");
  return `drawtext=textfile='${safe}':fontcolor=${color}:fontsize=${size}:x=(w-text_w)/2:y=${y}:box=1:boxcolor=black@0.35:boxborderw=18`;
}

/** Заглушка героя: цветной силуэт с первой буквой имени на прозрачном фоне. */
async function placeholderCharacter(name: string, color: string, out: string): Promise<void> {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const [r, g, b] = rgb(color);
  const body = `geq=r=${r}:g=${g}:b=${b}:a='if(lte(hypot(X-300,Y-330),230),255,if(between(X,170,430)*between(Y,520,900)*lte(hypot((X-300)*0.8,Y-560),260),255,0))'`;
  const initial = `${out}.initial.txt`;
  const label = `${out}.name.txt`;
  fs.writeFileSync(initial, name.charAt(0).toUpperCase());
  fs.writeFileSync(label, name);
  try {
    await ffmpeg([
      "-f", "lavfi", "-i", "color=c=black@0.0:s=600x900,format=rgba",
      "-vf", `${body},${textFilter(initial, 200, "250")},${textFilter(label, 44, "760")}`,
      "-frames:v", "1", out,
    ]);
  } catch {
    await ffmpeg(["-f", "lavfi", "-i", "color=c=black@0.0:s=600x900,format=rgba", "-vf", body, "-frames:v", "1", out]);
  } finally {
    fs.rmSync(initial, { force: true });
    fs.rmSync(label, { force: true });
  }
  fs.writeFileSync(`${out}.placeholder`, "");
}

/** Заглушка локации: тёплый вертикальный градиент с названием места. */
async function placeholderLocation(name: string, index: number, out: string): Promise<void> {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const palettes: [number, number, number, number, number, number][] = [
    [246, 196, 120, 210, 120, 60],
    [150, 200, 230, 60, 110, 160],
    [200, 225, 160, 90, 140, 80],
    [235, 180, 200, 140, 70, 110],
  ];
  const [r1, g1, b1, r2, g2, b2] = palettes[index % palettes.length]!;
  const mix = (a: number, b: number) => `'${a}+(${b}-${a})*Y/H'`;
  const grad = `geq=r=${mix(r1, r2)}:g=${mix(g1, g2)}:b=${mix(b1, b2)}`;
  const label = `${out}.name.txt`;
  fs.writeFileSync(label, name);
  try {
    await ffmpeg(["-f", "lavfi", "-i", `color=c=black:s=${W}x${H}`, "-vf", `format=rgb24,${grad},${textFilter(label, 52, "160")}`, "-frames:v", "1", out]);
  } catch {
    await ffmpeg(["-f", "lavfi", "-i", `color=c=black:s=${W}x${H}`, "-vf", `format=rgb24,${grad}`, "-frames:v", "1", out]);
  } finally {
    fs.rmSync(label, { force: true });
  }
  fs.writeFileSync(`${out}.placeholder`, "");
}

/** Рисует заглушки для всех героев и локаций, у которых ещё нет картинок. */
export async function ensureAssets(series: Series): Promise<void> {
  for (const c of series.characters) {
    const file = characterAsset(series.slug, c.id);
    if (!fs.existsSync(file)) await placeholderCharacter(c.name, c.color ?? "#0B6E8E", file);
  }
  for (const [i, l] of series.locations.entries()) {
    const file = locationAsset(series.slug, l.id);
    if (!fs.existsSync(file)) await placeholderLocation(l.name, i, file);
  }
}

export type AssetKind = "characters" | "locations";

/**
 * Ставит картинку героя или локации вместо заглушки (загрузка во вкладке «Бренды»).
 * Герой: PNG с прозрачным фоном; если прозрачности нет, белый фон убирается сам.
 * Локация: обрезается и масштабируется под вертикальный кадр 1080×1920.
 */
export async function saveAsset(slug: string, kind: AssetKind, id: string, input: string, variant?: CharacterVariant): Promise<string> {
  if (variant && kind !== "characters") throw new Error("Рот и моргание бывают только у героев");
  const base = characterAsset(slug, id);
  // Состояние накладывается поверх основной картинки, поэтому подгоняется под её размер пиксель в пиксель.
  let fit = "";
  if (variant) {
    if (!fs.existsSync(base) || isPlaceholder(base)) throw new Error("Сначала загрузите основную картинку героя");
    const { width, height } = await probe(base);
    fit = `,scale=${width}:${height}`;
  }
  const out = kind === "characters" ? characterAsset(slug, id, variant) : locationAsset(slug, id);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.upload.png`;
  let filter: string;
  if (kind === "locations") {
    filter = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=rgb24`;
  } else {
    const hasAlpha = /a|pal8/.test(await pixelFormat(input));
    // Высота героя до 1400 px: этого хватает и для крупного плана, и файл остаётся лёгким.
    filter = `${hasAlpha ? "format=rgba" : "format=rgba,colorkey=0xFFFFFF:0.12:0.08"},${fit ? fit.slice(1) : "scale=-2:'min(1400,ih)'"}`;
  }
  try {
    await ffmpeg(["-i", input, "-vf", filter, "-frames:v", "1", tmp]);
  } catch {
    fs.rmSync(tmp, { force: true });
    throw new Error("Не получилось прочитать картинку — пришлите PNG, JPG или WEBP");
  }
  fs.renameSync(tmp, out);
  fs.rmSync(`${out}.placeholder`, { force: true });
  // Новая основная картинка — старые состояния к ней больше не подходят по размеру и форме.
  if (kind === "characters" && !variant) for (const v of CHARACTER_VARIANTS) fs.rmSync(characterAsset(slug, id, v), { force: true });
  return out;
}

/** Высота героя в кадре: чем больше героев в сцене, тем они мельче, чтобы не налезали друг на друга. */
export function spriteHeight(count: number): number {
  return count <= 1 ? 1100 : count === 2 ? 960 : count === 3 ? 800 : 660;
}

/** Центры героев по ширине холста: один — в центре, двое — по бокам, трое — веером. */
export function castPositions(count: number): number[] {
  if (count <= 1) return [0.5];
  // Ближе к центру: камера показывает не весь холст, а крайние герои не должны уходить за край кадра.
  if (count === 2) return [0.33, 0.67];
  if (count === 3) return [0.26, 0.5, 0.74];
  return Array.from({ length: count }, (_, i) => 0.2 + (0.6 * i) / (count - 1));
}

/** Выражение высоты героя: подпрыгивает, пока говорит, и чуть покачивается всё время. */
export function bounceExpression(ranges: [number, number][], phase: number): string {
  const talking = spans(ranges);
  return `H-${FEET_FROM_BOTTOM}-h-(${talking})*24*abs(sin(t*9))+5*sin(t*1.6+${phase.toFixed(2)})`;
}

/** Сумма отрезков для выражений ffmpeg: between(t,a,b)+… или 0. */
function spans(ranges: [number, number][]): string {
  return ranges.map(([s, e]) => `between(t,${s.toFixed(2)},${e.toFixed(2)})`).join("+") || "0";
}

/**
 * Когда показывать «рот открыт»: по громкости голоса, если она известна,
 * иначе в ритм реплики (≈6 раз в секунду) — например, при демо-тишине вместо голоса.
 */
export function talkExpression(speaking: [number, number][], mouth?: [number, number][]): string {
  if (mouth && mouth.length) return spans(mouth);
  if (!speaking.length) return "0";
  return `(${spans(speaking)})*lt(mod(t*6.5,1),0.5)`;
}

/** Моргание: на 0.13 с, у каждого героя свой ритм, чтобы не моргали хором. */
export function blinkExpression(index: number): string {
  const period = 3.1 + ((index * 0.73) % 1.6);
  // Первое моргание — не в начале сцены, а через 0.9–2.4 с.
  const first = 0.9 + ((index * 0.83) % 1.5);
  return `lt(mod(t+${(period - first).toFixed(2)},${period.toFixed(2)}),0.13)`;
}

interface Composition {
  args: string[];
  filter: string;
}

function compose(
  series: Series,
  scene: Scene,
  speaking: Record<string, [number, number][]>,
  seconds: number,
  still: boolean,
  sceneIndex: number,
  mouth: Record<string, [number, number][]> = {},
): Composition {
  const bg = locationAsset(series.slug, scene.location);
  const cast = scene.characters.filter((id) => fs.existsSync(characterAsset(series.slug, id))).slice(0, 5);
  const loop = ["-loop", "1", "-framerate", String(config.render.fps), "-i"];
  const args = [...loop, bg];
  let input = 1;

  const parts = [`[0:v]scale=${CW}:${CH}:force_original_aspect_ratio=increase,crop=${CW}:${CH},setsar=1[bg0]`];
  const xs = castPositions(cast.length);
  const height = spriteHeight(cast.length);
  let layer = "bg0";
  let n = 0;
  cast.forEach((id, i) => {
    const x = `${Math.round(CW * xs[i]!)}-w/2`;
    const y = still ? `H-${FEET_FROM_BOTTOM}-h` : bounceExpression(speaking[id] ?? [], i * 1.3);
    // Слои героя: основная картинка, поверх — моргание и рот (если такие картинки есть).
    const layers: { file: string; enable?: string }[] = [{ file: characterAsset(series.slug, id) }];
    if (!still) {
      const blink = characterAsset(series.slug, id, "blink");
      if (fs.existsSync(blink)) layers.push({ file: blink, enable: blinkExpression(i) });
      const talk = characterAsset(series.slug, id, "talk");
      const open = talkExpression(speaking[id] ?? [], mouth[id]);
      if (fs.existsSync(talk) && open !== "0") layers.push({ file: talk, enable: open });
    }
    for (const l of layers) {
      args.push(...loop, l.file);
      const sprite = `s${n}`;
      parts.push(`[${input}:v]format=rgba,scale=-2:${height}[${sprite}]`);
      const next = `bg${++n}`;
      parts.push(`[${layer}][${sprite}]overlay=x='${x}':y='${y}':eval=frame${l.enable ? `:enable='${l.enable}'` : ""}[${next}]`);
      layer = next;
      input++;
    }
  });
  // Камера: медленный проезд по холсту, в чётных и нечётных сценах в разные стороны.
  const dx = CW - W;
  const dy = CH - H;
  const camX = sceneIndex % 2 === 0 ? `${dx}*t/${seconds.toFixed(2)}` : `${dx}-${dx}*t/${seconds.toFixed(2)}`;
  const crop = still ? `crop=${W}:${H}:${Math.round(dx / 2)}:${Math.round(dy / 2)}` : `crop=${W}:${H}:x='${camX}':y='${dy}*t/${seconds.toFixed(2)}'`;
  parts.push(`[${layer}]${crop},fps=${config.render.fps},format=yuv420p[out]`);
  return { args, filter: parts.join(";") };
}

/** Кадр-обложка сцены: фон и герои на местах, без движения. */
export async function cutoutStill(series: Series, scene: Scene, out: string): Promise<void> {
  await ensureAssets(series);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const { args, filter } = compose(series, scene, {}, 1, true, 0);
  await ffmpeg([...args, "-filter_complex", filter.replace("format=yuv420p[out]", "format=rgb24[out]"), "-map", "[out]", "-frames:v", "1", out]);
}

/** Клип сцены: герои говорят по таймингу озвучки, камера едет. */
export async function cutoutClip(opts: {
  series: Series;
  scene: Scene;
  sceneIndex: number;
  seconds: number;
  /** Когда говорит каждый герой, секунды от начала сцены. */
  speaking: Record<string, [number, number][]>;
  /** Когда у героя открыт рот — по громкости голоса (необязательно). */
  mouth?: Record<string, [number, number][]>;
  out: string;
}): Promise<void> {
  await ensureAssets(opts.series);
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  const { args, filter } = compose(opts.series, opts.scene, opts.speaking, opts.seconds, false, opts.sceneIndex, opts.mouth);
  await ffmpeg([...args, "-filter_complex", filter, "-map", "[out]", "-t", opts.seconds.toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-an", opts.out]);
}
