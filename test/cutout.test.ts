import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isolate } from "./helpers.js";

// Перекладка на всём конвейере: никаких ключей для кадров и видео, серия стоит $0.
const dataDir = isolate({ IMAGE_ENGINE: "auto", VIDEO_ENGINE: "auto" });
// У демо-сериала картинки уже нарисованы; одну убираем, чтобы проверить заглушку.
fs.rmSync(path.join(dataDir, "series", "assets", "bozor-seriali", "characters", "sabzi.png"));
const { newEpisode } = await import("../src/pipeline.js");
const { probe } = await import("../src/media/ffmpeg.js");
const { episodeDir, loadSeries } = await import("../src/store.js");
const { characterAsset, locationAsset, isPlaceholder } = await import("../src/media/cutout.js");

test("без платных движков серия собирается перекладкой бесплатно", async () => {
  const ep = await newEpisode("bozor-seriali");
  assert.equal(ep.status, "awaiting_approval", ep.error);
  assert.deepEqual(ep.engines, { image: "cutout", video: "cutout" });
  assert.equal(ep.costUsd, 0);

  const info = await probe(path.join(episodeDir(ep.id), ep.final!));
  assert.equal(info.width, 1080);
  assert.equal(info.height, 1920);
  assert.ok(Math.abs(info.duration - ep.voice!.total) < 0.5);

  // Нарисованные картинки студия не трогает; для героя без картинки — заглушка с пометкой.
  const series = loadSeries("bozor-seriali");
  for (const c of series.characters) {
    assert.ok(fs.existsSync(characterAsset(series.slug, c.id)), c.id);
    assert.equal(isPlaceholder(characterAsset(series.slug, c.id)), c.id === "sabzi", c.id);
  }
  for (const l of series.locations) assert.equal(isPlaceholder(locationAsset(series.slug, l.id)), false);
});

test("рот по громкости: открыт на громких окнах через одно, тишина — без движения", async () => {
  const { mouthOpenRanges, loudness } = await import("../src/media/ffmpeg.js");
  assert.deepEqual(mouthOpenRanges([-120, -120, -120]), []);
  // Громко, громко, пауза, громко, громко — рот открыт на чётных громких окнах.
  const ranges = mouthOpenRanges([-20, -21, -80, -22, -19, -20], 0.1);
  assert.deepEqual(ranges.map(([s, e]) => [Number(s.toFixed(2)), Number(e.toFixed(2))]), [[0, 0.1], [0.4, 0.5]]);

  const wav = path.join(dataDir, "beep.wav");
  const { execFileSync } = await import("node:child_process");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=f=300:d=0.4", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=0.4", "-filter_complex", "[0][1]concat=n=2:v=0:a=1", wav]);
  const levels = await loudness(wav);
  assert.ok(levels.length >= 9 && levels.length <= 11, String(levels.length));
  assert.ok(levels[1]! > -30 && levels.at(-2)! === -120, levels.join(","));
});

test("выражения перекладки: рот в ритм реплики без голоса, моргание не в начале сцены", async () => {
  const { talkExpression, blinkExpression } = await import("../src/media/cutout.js");
  assert.equal(talkExpression([]), "0");
  assert.equal(talkExpression([[0.5, 1.5]], [[0.6, 0.68]]), "between(t,0.60,0.68)");
  assert.match(talkExpression([[0.5, 1.5]]), /^\(between\(t,0\.50,1\.50\)\)\*lt\(mod\(t\*6\.5,1\),0\.5\)$/);
  for (let i = 0; i < 5; i++) {
    const [, shift, period] = /mod\(t\+([\d.]+),([\d.]+)\)/.exec(blinkExpression(i))!;
    const first = Number(period) - Number(shift);
    assert.ok(first > 0.85 && first < 2.45, `герой ${i}: первое моргание в ${first}`);
  }
});

test("состояния героя: только поверх настоящей картинки, подгоняются по размеру, сбрасываются при замене", async () => {
  const { saveAsset } = await import("../src/media/cutout.js");
  const { probe } = await import("../src/media/ffmpeg.js");
  const { execFileSync } = await import("node:child_process");
  const img = (name: string, size: string) => {
    const file = path.join(dataDir, name);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=white:s=${size}`, "-vf", "drawbox=x=40:y=40:w=100:h=200:c=red:t=fill", "-frames:v", "1", file]);
    return file;
  };
  // У sabzi в этом тесте заглушка — рот к ней не загрузить.
  await assert.rejects(saveAsset("bozor-seriali", "characters", "sabzi", img("talk.png", "300x450"), "talk"), /основную картинку/);
  await assert.rejects(saveAsset("bozor-seriali", "locations", "stall", img("x.png", "300x450"), "talk"), /только у героев/);

  await saveAsset("bozor-seriali", "characters", "sabzi", img("base.png", "400x600"));
  const talk = await saveAsset("bozor-seriali", "characters", "sabzi", img("talk2.png", "300x450"), "talk");
  const base = characterAsset("bozor-seriali", "sabzi");
  assert.deepEqual([(await probe(talk)).width, (await probe(talk)).height], [(await probe(base)).width, (await probe(base)).height]);

  await saveAsset("bozor-seriali", "characters", "sabzi", img("base2.png", "500x700"));
  assert.equal(fs.existsSync(talk), false); // новая основная картинка — старый рот не подходит
});

test("образцы для платных движков: только нарисованные герои сцены и её место", async () => {
  const { sceneReferences } = await import("../src/agents/keyframeGenerator.js");
  const { trainCharacter } = await import("../src/agents/soulTrainer.js");
  const series = loadSeries("bozor-seriali");
  const refs = sceneReferences(series, { id: "s1", location: "stall", characters: ["qovun", "nobody", "anor"], visual: "", camera: "", lines: [], duration_sec: 5 });
  assert.deepEqual(refs.map((r) => [r.kind, r.label]), [["character", "Qovun opa"], ["character", "Anor"], ["location", "Katta bozor, ряд с фруктами"]]);
  assert.ok(refs[0]!.base64.length > 1000);
  await assert.rejects(trainCharacter("bozor-seriali", "qovun"), /Higgsfield не подключён/);
});
