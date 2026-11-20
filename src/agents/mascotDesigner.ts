import { z } from "zod";
import { askStructured } from "../llm.js";
import { log } from "../log.js";
import { saveSeries, seriesExists } from "../store.js";
import type { Series } from "../types.js";
import { agentInfo } from "./index.js";

const AGENT = agentInfo(29);

/** Что клиент рассказывает о себе. */
export interface BrandBrief {
  company: string;
  product: string;
  audience: string;
  tone: string;
  language: "uz" | "ru" | "en";
  wishes?: string;
  contact?: string;
}

const BrandSeriesSchema = z.object({
  title: z.string(),
  logline: z.string(),
  tone: z.string(),
  audience: z.string(),
  style_guide: z.string(),
  locations: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
  characters: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      role: z.string(),
      personality: z.string(),
      look: z.string(),
      catchphrases: z.array(z.string()),
      gender: z.enum(["female", "male"]),
      age: z.enum(["child", "young", "adult", "elder"]),
    }),
  ),
  rubrics: z.array(z.string()),
  rules: z.array(z.string()),
  hashtags: z.array(z.string()),
});

const SYSTEM = `Ты — Дизайнер маскотов для брендов (агент №29) в AI-студии, которая делает для компаний ежедневные короткие мультсериалы в Instagram Reels.

По описанию компании придумай сериал, в котором бренд живёт как персонаж, а не как реклама в лоб:
- 1 главный маскот — сам продукт или символ бренда в виде героя, запоминающийся силуэт и характер;
- 2–3 второстепенных героя: покупатели, соседи, конкуренты-соперники (без реальных брендов), чтобы были конфликты и шутки;
- 3–4 локации, где происходит действие (id латиницей, коротко);
- 4–5 рубрик, каждая — повторяющийся формат серии, который можно снимать каждый день;
- правила: что бренд разрешает и что нельзя (никаких обещаний, которых нет в описании, никаких цен и скидок без запроса клиента, уважение к покупателю);
- style_guide — визуальный стиль одной фразой по-русски, семейная 3D-анимация, вертикальный кадр 9:16;
- id героев — латиницей в нижнем регистре, без пробелов;
- catchphrases — 1–2 фразы на языке сериала;
- hashtags — 4–6 хэштегов с #.
Пиши описания по-русски. Реплики и фразы героев — на языке сериала.`;

/** Латиница в нижнем регистре для имени файла сериала. */
export function slugify(text: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
    н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sh", ъ: "",
    ы: "y", ь: "", э: "e", ю: "yu", я: "ya", ў: "o", қ: "q", ғ: "g", ҳ: "h",
  };
  const base = text
    .toLowerCase()
    .split("")
    .map((ch) => map[ch] ?? ch)
    .join("")
    .replace(/[ʻʼ'`’‘]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "brand";
}

export function uniqueSlug(text: string): string {
  const base = slugify(text);
  let slug = base;
  for (let i = 2; seriesExists(slug); i++) slug = `${base}-${i}`;
  return slug;
}

const VOICES = {
  uz: { female: "uz-UZ-MadinaNeural", male: "uz-UZ-SardorNeural" },
  ru: { female: "ru-RU-SvetlanaNeural", male: "ru-RU-DmitryNeural" },
  en: { female: "en-US-JennyNeural", male: "en-US-GuyNeural" },
} as const;
const AGE_VOICE = {
  child: { pitch: "+15%", rate: "+8%" },
  young: { pitch: "+8%", rate: "+6%" },
  adult: { pitch: "+0%", rate: "+0%" },
  elder: { pitch: "-10%", rate: "-12%" },
} as const;
const COLORS = ["#0B6E8E", "#C2185B", "#C9772B", "#5B6BD8", "#2E8B57", "#8E44AD"];

const BASE_RULES = [
  "Только семейный юмор: без политики, религиозных шуток, пошлости и оскорблений.",
  "Никаких реальных людей, чужих брендов и логотипов.",
  "Никаких обещаний, цен и скидок, которых нет в описании клиента.",
];

export async function designBrandSeries(brief: BrandBrief): Promise<Series> {
  log.agent(AGENT, `собираю сериал для «${brief.company}»`);
  const raw = await askStructured({
    agent: AGENT,
    system: SYSTEM,
    prompt: [
      `Компания: ${brief.company}`,
      `Что продаёт: ${brief.product}`,
      `Аудитория: ${brief.audience}`,
      `Тон: ${brief.tone}`,
      `Язык сериала: ${brief.language}`,
      brief.wishes ? `Пожелания клиента: ${brief.wishes}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    schema: BrandSeriesSchema,
    effort: "high",
    mock: () => mockBrand(brief),
  });

  const slug = uniqueSlug(brief.company);
  const series: Series = {
    slug,
    title: raw.title,
    language: brief.language,
    logline: raw.logline,
    tone: raw.tone,
    audience: raw.audience,
    style_guide: raw.style_guide,
    locations: raw.locations.map((l) => ({ ...l, id: slugify(l.id) })),
    characters: raw.characters.map((c, i) => ({
      id: slugify(c.id),
      name: c.name,
      role: c.role,
      color: COLORS[i % COLORS.length],
      personality: c.personality,
      look: c.look,
      catchphrases: c.catchphrases,
      voice: { azure: VOICES[brief.language][c.gender], ...AGE_VOICE[c.age] },
    })),
    rubrics: raw.rubrics,
    rules: [...BASE_RULES, ...raw.rules],
    target_duration_sec: 25,
    hashtags: raw.hashtags.map((t) => (t.startsWith("#") ? t : `#${t}`).replace(/\s+/g, "")),
    client: { company: brief.company, product: brief.product, contact: brief.contact },
    createdAt: new Date().toISOString(),
  };
  if (series.characters.length === 0 || series.locations.length === 0) throw new Error("Дизайнер маскотов не придумал героев или локации");
  saveSeries(series);
  log.agent(AGENT, `готово: «${series.title}», ${series.characters.length} героя, файл series/${slug}.json`);
  return series;
}

function mockBrand(brief: BrandBrief): z.infer<typeof BrandSeriesSchema> {
  const hero = brief.product.split(/[,.]/)[0]!.trim() || brief.company;
  return {
    title: `${brief.company}: сериал`,
    logline: `Маскот «${hero}» каждый день выручает покупателей ${brief.company}. Демо-сериал без Claude.`,
    tone: brief.tone,
    audience: brief.audience,
    style_guide: "Семейная 3D-анимация, тёплые цвета, крупные выразительные герои, вертикальный кадр 9:16.",
    locations: [
      { id: "shop", name: `Точка ${brief.company}`, description: "Светлый уютный зал, где покупатели встречают маскота." },
      { id: "street", name: "Улица махалли", description: "Солнечная улица, соседи, детвора, чайхана на углу." },
      { id: "home", name: "Дом покупателя", description: "Кухня и дастархан, куда маскот приходит в гости." },
    ],
    characters: [
      {
        id: "mascot",
        name: hero,
        role: `Маскот ${brief.company}`,
        personality: "Добрый, находчивый, всегда приходит на помощь.",
        look: `${hero} в виде весёлого персонажа с большими глазами и фирменным шарфом цвета бренда.`,
        catchphrases: ["Men shu yerdaman!"],
        gender: "male",
        age: "young",
      },
      {
        id: "mijoz",
        name: "Malika",
        role: "Постоянная покупательница",
        personality: "Придирчивая, но справедливая, любит всё проверять.",
        look: "Молодая девушка в яркой куртке с телефоном в руке.",
        catchphrases: ["Rostdanmi?"],
        gender: "female",
        age: "young",
      },
    ],
    rubrics: ["Маскот спасает день", "Покупатель спрашивает — маскот отвечает", "Закулисье: как это делается", "Соседи спорят"],
    rules: brief.wishes ? [brief.wishes] : [],
    hashtags: [`#${slugify(brief.company).replace(/-/g, "")}`, "#uzbekistan", "#multfilm"],
  };
}
