import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isolate } from "./helpers.js";

// Полный прогон всех 15 агентов в демо-режиме: настоящий ffmpeg, без внешних сервисов.
const dataDir = isolate();
const { newEpisode, approveEpisode, redoEpisode, rejectEpisode, runEpisode } = await import("../src/pipeline.js");
const { probe } = await import("../src/media/ffmpeg.js");
const { loadEpisode, episodeDir } = await import("../src/store.js");

let episodeId = "";

test("новая серия проходит весь конвейер и ждёт одобрения", async () => {
  const ep = await newEpisode("bozor-seriali");
  episodeId = ep.id;
  assert.equal(ep.status, "awaiting_approval", ep.error);
  assert.ok(ep.idea && ep.script && ep.hook && ep.shots && ep.voice && ep.qa);
  assert.equal(ep.qa.pass, true);
  assert.ok(ep.final);

  const final = path.join(episodeDir(ep.id), ep.final);
  const info = await probe(final);
  assert.equal(info.width, 1080);
  assert.equal(info.height, 1920);
  assert.ok(info.hasAudio);
  assert.ok(Math.abs(info.duration - ep.voice.total) < 0.5, `длина ${info.duration} ≠ ${ep.voice.total}`);
  assert.ok(fs.existsSync(path.join(episodeDir(ep.id), "subs.srt")));
  assert.ok(ep.script.scenes.every((s) => ep.keyframes?.[s.id] && ep.clips?.[s.id]));
  assert.ok(dataDir && fs.existsSync(path.join(dataDir, "episodes", ep.id, "episode.json")));
});

test("повторный запуск готового эпизода ничего не переделывает", async () => {
  const before = loadEpisode(episodeId);
  const after = await runEpisode(episodeId);
  assert.equal(after.status, "awaiting_approval");
  assert.equal(after.final, before.final);
  assert.equal(after.script?.title, before.script?.title);
});

test("переделка учитывает правки и снова присылает ролик", async () => {
  const ep = await redoEpisode(episodeId, "Сделай шутку смешнее", "script");
  assert.equal(ep.status, "awaiting_approval", ep.error);
  assert.ok(ep.feedback.includes("Продюсер: Сделай шутку смешнее"));
  assert.equal(ep.approval?.decision, undefined); // новый запрос одобрения после переделки
  assert.ok(ep.final);
});

test("одобрение без Instagram готовит ролик к ручной публикации", async () => {
  const ep = await approveEpisode(episodeId);
  assert.equal(ep.status, "approved");
  assert.equal(ep.publish?.dryRun, true);
  assert.equal(ep.error, undefined);
});

test("отклонённую серию конвейер больше не трогает", async () => {
  const second = await newEpisode("bozor-seriali");
  await rejectEpisode(second.id);
  const again = await runEpisode(second.id);
  assert.equal(again.status, "rejected");
});
