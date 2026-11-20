import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { isolate } from "./helpers.js";

// Русская версия серии: те же кадры, реплики из перевода, своя озвучка и субтитры.
isolate();
const { newEpisode, approveEpisode, makeLanguageVersion } = await import("../src/pipeline.js");
const { loadEpisode, episodeFile, listEpisodes } = await import("../src/store.js");
const { voiceForLanguage } = await import("../src/providers/tts.js");
const clients = await import("../src/clients.js");

async function waitFor(check: () => boolean, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("не дождались");
    await new Promise((r) => setTimeout(r, 200));
  }
}

test("голос для другого языка: тот же пол, темп и высота", () => {
  assert.deepEqual(voiceForLanguage({ azure: "uz-UZ-MadinaNeural", rate: "+5%", gemini: "Leda" }, "ru"), { azure: "ru-RU-SvetlanaNeural", rate: "+5%", gemini: "Leda" });
  assert.equal(voiceForLanguage({ azure: "uz-UZ-SardorNeural" }, "ru").azure, "ru-RU-DmitryNeural");
  assert.equal(voiceForLanguage({ azure: "ru-RU-DmitryNeural" }, "ru").azure, "ru-RU-DmitryNeural");
  assert.deepEqual(voiceForLanguage({ gemini: "Kore" }, "ru"), { gemini: "Kore" });
});

test("русская версия: перевод реплик, те же кадры, отдельная серия на одобрение", async () => {
  const ep = await newEpisode("bozor-seriali");
  assert.equal(ep.status, "awaiting_approval", ep.error);
  await assert.rejects(makeLanguageVersion("ep-20260101-00000000"), /./);

  const child = await makeLanguageVersion(ep.id, "ru");
  assert.equal(child.status, "awaiting_approval", child.error);
  assert.equal(child.language, "ru");
  assert.equal(child.parentId, ep.id);
  const parent = loadEpisode(ep.id);
  assert.equal(parent.versions?.ru, child.id);
  const pl = parent.script!.scenes[0]!.lines[0]!;
  const cl = child.script!.scenes[0]!.lines[0]!;
  assert.deepEqual([cl.text, cl.translation_ru], [pl.translation_ru, pl.text]);
  assert.equal(child.script!.caption, parent.script!.caption_ru);
  assert.deepEqual(fs.readFileSync(episodeFile(child, child.keyframes!.s1!)), fs.readFileSync(episodeFile(parent, parent.keyframes!.s1!)));
  assert.ok(child.final && fs.existsSync(episodeFile(child, child.final)));
  assert.match(fs.readFileSync(episodeFile(child, child.subtitles!), "utf8"), new RegExp(cl.text.slice(0, 10).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  await assert.rejects(makeLanguageVersion(ep.id, "ru"), /уже есть/);
  await assert.rejects(makeLanguageVersion(child.id, "ru"), /уже языковая версия/);
});

test("клиенту со второй версией русская собирается сама и не тратит тариф", async () => {
  const c = clients.createClient({ brand: "bozor-seriali", contactName: "Дилноза", email: "boss@bozor.uz", plan: "network" });
  clients.updateClient(c.id, { secondLanguage: "ru" });
  assert.throws(() => clients.updateClient(c.id, { secondLanguage: "de" }), /только русская/);
  const before = clients.usage(clients.getClient(c.id)).used;

  const ep = await newEpisode("bozor-seriali");
  const sent = await approveEpisode(ep.id); // студия → клиенту, и следом собирается русская версия
  assert.equal(sent.status, "awaiting_client");
  await waitFor(() => {
    const v = loadEpisode(ep.id).versions?.ru;
    return Boolean(v) && loadEpisode(v!).status === "awaiting_approval";
  });
  assert.equal(clients.usage(clients.getClient(c.id)).used, before + 1); // версия не засчитана
  assert.equal(listEpisodes().filter((e) => e.parentId === ep.id).length, 1);
});
