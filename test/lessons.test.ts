import assert from "node:assert/strict";
import { test } from "node:test";
import { isolate } from "./helpers.js";

isolate();
const { pastLessons } = await import("../src/pipeline.js");
const { createEpisode, saveEpisode } = await import("../src/store.js");

test("память правок: свежие замечания клиента и студии по сериалу, без повторов и без заметок контролёра", () => {
  const add = (series: string, feedback: string[], createdAt: string) => {
    const ep = createEpisode(series);
    ep.feedback = feedback;
    ep.createdAt = createdAt;
    saveEpisode(ep);
    return ep;
  };
  add("bozor-seriali", ["Клиент: Добавьте нашу акцию в конце", "Контролёр качества: звук тихий"], "2026-11-10T10:00:00Z");
  add("bozor-seriali", ["Продюсер: Короче, до 20 секунд", "Клиент: добавьте нашу акцию в конце"], "2026-11-12T10:00:00Z");
  add("other-brand", ["Клиент: Другой бренд"], "2026-11-13T10:00:00Z");
  const current = add("bozor-seriali", ["Клиент: Это текущая серия"], "2026-11-14T10:00:00Z");

  assert.deepEqual(pastLessons("bozor-seriali", current.id), ["Клиент: добавьте нашу акцию в конце", "Продюсер: Короче, до 20 секунд"]);
  assert.equal(pastLessons("bozor-seriali", current.id, 1).length, 1);
});
