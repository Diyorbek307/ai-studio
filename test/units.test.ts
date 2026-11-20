import assert from "node:assert/strict";
import { test } from "node:test";
import { isolate } from "./helpers.js";

isolate();
const { assTime, srtTime, assText, buildAss, buildSrt } = await import("../src/agents/subtitler.js");
const { layoutTimeline, LEAD_IN, GAP, TAIL } = await import("../src/agents/voiceUz.js");
const { normalizeScript, SCENE_MAX_SEC, SCENE_MIN_SEC } = await import("../src/agents/scriptwriter.js");
const { applyHook } = await import("../src/agents/hookMaster.js");
const { composeImagePrompt } = await import("../src/agents/consistencyKeeper.js");
const { techProblems } = await import("../src/agents/qualityController.js");
const { findFileUrl } = await import("../src/providers/fal.js");
const { buildSsml } = await import("../src/providers/tts.js");
const { qaRedoStep, resetFrom, nextStep, STEPS } = await import("../src/pipeline.js");
const { publicMediaPath } = await import("../src/server.js");
const { clip } = await import("../src/integrations/telegram.js");
const { postCaption, AI_LABEL } = await import("../src/agents/publisher.js");
const { loadSeries } = await import("../src/store.js");
const { SeriesSchema } = await import("../src/types.js");

const series = loadSeries("bozor-seriali");

test("библия сериала читается и проходит схему", () => {
  assert.equal(series.characters.length, 5);
  assert.ok(SeriesSchema.safeParse(series).success);
});

test("время в форматах ASS и SRT", () => {
  assert.equal(assTime(0), "0:00:00.00");
  assert.equal(assTime(3.456), "0:00:03.46");
  assert.equal(assTime(3725.5), "1:02:05.50");
  assert.equal(srtTime(3.456), "00:00:03,456");
  assert.equal(srtTime(61.2), "00:01:01,200");
});

test("текст субтитров не ломает разметку ASS", () => {
  assert.equal(assText("Salom {\\b1}dunyo\\"), "Salom /b1dunyo/");
  assert.equal(assText("bir\nikki"), "bir\\Nikki");
});

test("раскладка реплик: сцена не короче задуманной и вмещает все реплики", () => {
  const t = layoutTimeline([
    { id: "s1", duration_sec: 5, lines: [{ character: "a", text: "x", file: "a.wav", seconds: 1 }] },
    {
      id: "s2",
      duration_sec: 3,
      lines: [
        { character: "a", text: "x", file: "b.wav", seconds: 2 },
        { character: "b", text: "y", file: "c.wav", seconds: 2 },
      ],
    },
    { id: "s3", duration_sec: 4, lines: [] },
  ]);
  assert.equal(t.scenes[0]!.end, 5); // реплика короткая — сцена длится сколько задумано
  const s2Spoken = LEAD_IN + 2 + GAP + 2 + TAIL;
  assert.equal(t.scenes[1]!.end, Math.round((5 + s2Spoken) * 100) / 100); // реплики длиннее — сцена растягивается
  assert.equal(t.lines[1]!.start, 5 + LEAD_IN);
  assert.equal(t.scenes[2]!.end - t.scenes[2]!.start, 4);
  assert.equal(t.total, t.scenes[2]!.end);
});

test("сценарий нормализуется: чужие герои и локации заменяются, длительности в рамках", () => {
  const script = normalizeScript(series, {
    title: "T",
    scenes: [
      {
        id: "x",
        location: "nowhere",
        characters: ["ghost", "anor"],
        visual: "v",
        camera: "c",
        lines: [
          { character: "ghost", text: "Salom", translation_ru: "Привет", emotion: "happy" },
          { character: "anor", text: "   ", translation_ru: "", emotion: "" },
        ],
        duration_sec: 99,
      },
      { id: "y", location: "tandir", characters: [], visual: "v", camera: "c", lines: [], duration_sec: 0.5 },
    ],
    caption: "c",
    caption_ru: "c",
    hashtags: ["kulgili", "#bozorseriali"],
    cliffhanger: "",
  });
  const [s1, s2] = script.scenes;
  assert.equal(s1!.id, "s1");
  assert.equal(s1!.location, series.locations[0]!.id);
  assert.deepEqual(s1!.characters, ["anor"]);
  assert.equal(s1!.lines.length, 1);
  assert.equal(s1!.lines[0]!.character, "anor");
  assert.equal(s1!.duration_sec, SCENE_MAX_SEC);
  assert.equal(s2!.duration_sec, SCENE_MIN_SEC);
  assert.ok(script.hashtags.includes("#kulgili"));
  assert.equal(new Set(script.hashtags).size, script.hashtags.length);
});

test("хук заменяет первую реплику и первый кадр", () => {
  const base = normalizeScript(series, {
    title: "T",
    scenes: [{ id: "s1", location: "stall", characters: ["qovun"], visual: "old", camera: "c", lines: [{ character: "qovun", text: "eski", translation_ru: "старое", emotion: "" }], duration_sec: 5 }],
    caption: "",
    caption_ru: "",
    hashtags: [],
    cliffhanger: "",
  });
  const hooked = applyHook(base, { opening_line: "Yangi!", opening_line_ru: "Новое!", on_screen_text: "VOY", visual: "new visual" });
  assert.equal(hooked.scenes[0]!.lines[0]!.text, "Yangi!");
  assert.equal(hooked.scenes[0]!.lines[0]!.character, "qovun");
  assert.equal(hooked.scenes[0]!.visual, "new visual");
});

test("промпт кадра включает канон героев и стиль дословно", () => {
  const designed = {
    ...series,
    style_prompt: "STYLE-CANON",
    characters: series.characters.map((c) => ({ ...c, visual_prompt: `CANON-${c.id}` })),
  };
  const script = normalizeScript(designed, {
    title: "T",
    scenes: [{ id: "s1", location: "tandir", characters: ["somsa"], visual: "v", camera: "c", lines: [], duration_sec: 5 }],
    caption: "",
    caption_ru: "",
    hashtags: [],
    cliffhanger: "",
  });
  const prompt = composeImagePrompt(designed, script, "s1", "Somsa aka laughs");
  assert.ok(prompt.startsWith("Somsa aka laughs"));
  assert.ok(prompt.includes("CANON-somsa"));
  assert.ok(!prompt.includes("CANON-anor"));
  assert.ok(prompt.includes("STYLE-CANON"));
  assert.ok(prompt.includes("no text"));
});

test("техническая проверка ролика", () => {
  assert.deepEqual(techProblems({ width: 1080, height: 1920, duration: 30, hasAudio: true, sizeMb: 5 }), []);
  const bad = techProblems({ width: 720, height: 1280, duration: 3, hasAudio: false, sizeMb: 300 });
  assert.equal(bad.length, 4);
});

test("ссылка на файл ищется в ответах разной формы", () => {
  assert.equal(findFileUrl({ images: [{ url: "https://x/a.png" }] }, "image"), "https://x/a.png");
  assert.equal(findFileUrl({ video: { url: "https://x/v", content_type: "video/mp4" } }, "video"), "https://x/v");
  assert.equal(findFileUrl({ data: { output: ["https://x/b.mp4?sig=1"] } }, "video"), "https://x/b.mp4?sig=1");
  assert.equal(findFileUrl({ images: [{ url: "https://x/a.png" }] }, "video"), undefined);
});

test("SSML экранирует текст реплики", () => {
  const ssml = buildSsml(`Salom <b> & "do'st"`, "uz", { azure: "uz-UZ-MadinaNeural", rate: "+5%" });
  assert.ok(ssml.includes('xml:lang="uz-UZ"'));
  assert.ok(ssml.includes("uz-UZ-MadinaNeural"));
  assert.ok(ssml.includes("Salom &lt;b&gt; &amp; &quot;do&apos;st&quot;"));
});

test("переделка после проверки качества начинается с нужного шага", () => {
  const review = { pass: false, issues: [], summary_ru: "" };
  const tech = { width: 1080, height: 1920, duration: 20, hasAudio: true, sizeMb: 1, problems: [] as string[] };
  assert.equal(qaRedoStep({ tech, review: { ...review, redo_from: "shots" }, pass: false, checkedAt: "" }), "shots");
  assert.equal(qaRedoStep({ tech, review: { ...review, redo_from: "none" }, pass: false, checkedAt: "" }), undefined);
  assert.equal(qaRedoStep({ tech: { ...tech, problems: ["нет звука"] }, review: { ...review, redo_from: "script" }, pass: false, checkedAt: "" }), "edit");
});

test("сброс шага стирает его результат и всё, что после", () => {
  const ep = {
    id: "ep-20260101-00000000",
    series: "bozor-seriali",
    createdAt: "",
    updatedAt: "",
    status: "in_progress" as const,
    feedback: [],
    attempts: {},
    costUsd: 0,
    idea: { title: "", logline: "", characters: [], location: "", hook_idea: "", why_it_works: "", score: 1 },
    script: { title: "", scenes: [], caption: "", caption_ru: "", hashtags: [], cliffhanger: "" },
    edited: "edited.mp4",
    final: "final.mp4",
  };
  resetFrom(ep, "script");
  assert.ok(ep.idea);
  assert.equal(ep.script, undefined);
  assert.equal(ep.final, undefined);
  assert.equal(nextStep(ep), "script");
  assert.equal(STEPS[0], "idea");
});

test("публично отдаются только ролик и кадры, без выхода из папки", () => {
  const id = "ep-20260101-00000000";
  assert.equal(publicMediaPath(id, "../../../etc/passwd"), undefined);
  assert.equal(publicMediaPath(id, "episode.json"), undefined);
  assert.equal(publicMediaPath(id, "voice/s1-1.wav"), undefined);
  assert.equal(publicMediaPath("../secret", "final.mp4"), undefined);
});

test("подпись поста помечена как сделанная AI", () => {
  const caption = postCaption({
    id: "ep-20260101-00000000",
    series: "s",
    createdAt: "",
    updatedAt: "",
    status: "approved",
    feedback: [],
    attempts: {},
    costUsd: 0,
    script: { title: "", scenes: [], caption: "Savol?", caption_ru: "", hashtags: ["#a", "#b"], cliffhanger: "" },
  });
  assert.ok(caption.startsWith("Savol?"));
  assert.ok(caption.includes("#a #b"));
  assert.ok(caption.endsWith(AI_LABEL));
});

test("длинный текст обрезается под лимит Telegram", () => {
  const long = "so'z ".repeat(400);
  const cut = clip(long, 1024);
  assert.ok(cut.length <= 1024);
  assert.ok(cut.endsWith("…"));
  assert.equal(clip("qisqa", 1024), "qisqa");
});

test("ASS и SRT собираются из раскладки", () => {
  const t = layoutTimeline([{ id: "s1", duration_sec: 4, lines: [{ character: "anor", text: "Obuna boʻling!", file: "a", seconds: 1.5 }] }]);
  const ass = buildAss(t, "VOY!", "DejaVu Sans");
  assert.ok(ass.includes("Style: Hook,DejaVu Sans"));
  assert.ok(ass.includes("Dialogue: 1,0:00:00.00,0:00:02.50,Hook,,0,0,0,,VOY!"));
  assert.ok(ass.includes(",Line,anor,0,0,0,,Obuna boʻling!"));
  assert.ok(buildSrt(t).startsWith("1\n00:00:00,300 --> 00:00:01,800\nObuna boʻling!"));
});
