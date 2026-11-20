import { askStructured } from "../llm.js";
import { log } from "../log.js";
import { type Idea, type Script, ScriptSchema, type Series } from "../types.js";
import { characterById, locationById, seriesContext } from "./context.js";
import { agentInfo } from "./index.js";

const AGENT = agentInfo(12);

export const SCENE_MIN_SEC = 3;
export const SCENE_MAX_SEC = 10;

const SYSTEM = `Ты — Сценарист серии (агент №12) в AI-студии мультсериала для Instagram Reels.

По идее серии напиши сценарий:
- 3–5 сцен, всего 20–40 секунд; у каждой сцены duration_sec от 3 до 10;
- в сцене 1–3 реплики, каждая не длиннее 12 слов: зритель читает субтитры на ходу;
- text — реплика на узбекском языке латиницей, с буквами oʻ и gʻ, живой разговорной речью;
- translation_ru — перевод реплики на русский для продюсера;
- emotion — эмоция одним-двумя словами по-английски (angry, excited, whispering...);
- character — id героя из библии, location — id локации из библии;
- visual — описание кадра на английском для художника: кто где стоит, что делает, эмоции, фон. Без текста, вывесок и логотипов в кадре;
- camera — план и движение камеры на английском (close-up, slow push-in...);
- первая сцена сразу цепляет, последняя — шутка или клиффхэнгер (cliffhanger — коротко по-русски);
- caption — подпись к посту на узбекском (1–2 предложения и вопрос зрителям), caption_ru — её перевод;
- hashtags — 3–6 хэштегов без пробелов, начинаются с #.

Соблюдай характеры героев и правила сериала. Если в задании есть замечания продюсера — учти каждое.`;

export async function writeScript(opts: {
  series: Series;
  idea: Idea;
  feedback: string[];
  episodeId: string;
}): Promise<Script> {
  const { series, idea, feedback } = opts;
  log.agent(AGENT, `пишу сценарий «${idea.title}»`);

  const prompt = [
    `Идея серии:\n${JSON.stringify(idea, null, 2)}`,
    feedback.length ? `Замечания, которые нужно учесть:\n${feedback.map((f) => `- ${f}`).join("\n")}` : "",
    "Напиши сценарий.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await askStructured({
    agent: AGENT,
    system: SYSTEM,
    context: seriesContext(series),
    prompt,
    schema: ScriptSchema,
    effort: "high",
    episodeId: opts.episodeId,
    mock: () => mockScript(series, idea),
  });

  const script = normalizeScript(series, raw);
  const total = script.scenes.reduce((s, sc) => s + sc.duration_sec, 0);
  log.agent(AGENT, `готово: ${script.scenes.length} сцен, ~${Math.round(total)} с`);
  return script;
}

/**
 * Приводит сценарий к тому, что умеет студия: неизвестные герои и локации заменяются,
 * длительности ограничиваются, пустые реплики выкидываются.
 */
export function normalizeScript(series: Series, script: Script): Script {
  const fallbackLocation = series.locations[0]?.id ?? "";
  const scenes = script.scenes
    .map((scene, i) => {
      const lines = scene.lines
        .filter((l) => l.text.trim() !== "")
        .map((l) => ({
          ...l,
          character: characterById(series, l.character) ? l.character : (scene.characters.find((c) => characterById(series, c)) ?? series.characters[0]!.id),
          text: l.text.trim(),
        }));
      const characters = [...new Set([...scene.characters, ...lines.map((l) => l.character)])].filter((c) => characterById(series, c));
      return {
        ...scene,
        id: `s${i + 1}`,
        location: locationById(series, scene.location) ? scene.location : fallbackLocation,
        characters,
        lines,
        duration_sec: Math.min(SCENE_MAX_SEC, Math.max(SCENE_MIN_SEC, Number(scene.duration_sec) || 5)),
      };
    })
    .slice(0, 6);
  if (scenes.length === 0) throw new Error("В сценарии нет ни одной сцены");

  const tags = [...new Set([...script.hashtags, ...series.hashtags].map((t) => (t.startsWith("#") ? t : `#${t}`).replace(/\s+/g, "")))];
  return { ...script, scenes, hashtags: tags.slice(0, 8) };
}

function mockScript(series: Series, idea: Idea): Script {
  const [a = series.characters[0]!.id, b = series.characters[1]?.id ?? a] = idea.characters;
  const loc = idea.location;
  return {
    title: idea.title,
    scenes: [
      {
        id: "s1",
        location: loc,
        characters: [a, b],
        visual: `${a} runs into the frame with big news, ${b} turns around surprised`,
        camera: "medium shot, quick push-in",
        lines: [{ character: a, text: "Voy, eshitmadingizmi? Katta yangilik bor!", translation_ru: "Ой, вы не слышали? Есть большая новость!", emotion: "excited" }],
        duration_sec: 5,
      },
      {
        id: "s2",
        location: loc,
        characters: [a, b],
        visual: `${b} leans closer, both whisper conspiratorially`,
        camera: "close-up, slow push-in",
        lines: [
          { character: b, text: "Qanaqa yangilik? Tezroq ayting!", translation_ru: "Какая новость? Говорите скорее!", emotion: "curious" },
          { character: a, text: "Ertaga bozorda katta toʻy boʻladi!", translation_ru: "Завтра на базаре будет большая свадьба!", emotion: "whispering" },
        ],
        duration_sec: 7,
      },
      {
        id: "s3",
        location: loc,
        characters: [a, b],
        visual: `${b} faints dramatically, ${a} fans with a leaf`,
        camera: "wide shot, static",
        lines: [{ character: b, text: "Kimning toʻyi? Men hali tayyor emasman!", translation_ru: "Чья свадьба? Я ещё не готов(а)!", emotion: "panicked" }],
        duration_sec: 6,
      },
    ],
    caption: "Kimning toʻyi deb oʻylaysiz? Izohlarda yozing!",
    caption_ru: "Как думаете, чья свадьба? Пишите в комментариях!",
    hashtags: ["#bozorseriali"],
    cliffhanger: "Чья же свадьба — узнаем в следующей серии",
  };
}
