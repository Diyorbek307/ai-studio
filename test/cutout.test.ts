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
