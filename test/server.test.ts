import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { isolate } from "./helpers.js";

isolate({ STUDIO_ADMIN_PASSWORD: "secret", PORT: "0" });
const { startServer } = await import("../src/server.js");
const { newEpisode } = await import("../src/pipeline.js");
const { loadEpisode } = await import("../src/store.js");
const { buildPreview } = await import("../src/preview.js");

let base = "";
let server: ReturnType<typeof startServer>;
let id = "";
const auth = { Authorization: "Basic " + Buffer.from("admin:secret").toString("base64") };

before(async () => {
  id = (await newEpisode("bozor-seriali")).id;
  server = startServer();
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("сайт открыт всем, пульт студии — только после входа", async () => {
  const landing = await fetch(base + "/");
  assert.equal(landing.status, 200);
  const html = await landing.text();
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("window.STUDIO_PUBLIC = ") && html.includes('"priceUsd":590'));

  const closed = await fetch(base + "/app", { redirect: "manual" });
  assert.equal(closed.status, 303);
  assert.equal(closed.headers.get("location"), "/login");
  assert.equal((await fetch(base + "/api/state")).status, 401);

  const page = await fetch(base + "/app", { headers: auth });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes("<title>AI-студия</title>"));
});

test("/api/state отдаёт серии, шаги и агентов", async () => {
  const res = await fetch(base + "/api/state", { headers: auth });
  const state = (await res.json()) as import("../src/studioState.js").StudioState;
  assert.equal(state.steps.length, 11);
  assert.equal(state.agents.length, 16);
  assert.equal(state.brands.find((b) => b.slug === "bozor-seriali")?.characters.length, 5);
  const ep = state.episodes.find((e) => e.id === id);
  assert.ok(ep);
  assert.equal(ep.status, "awaiting_approval");
  assert.equal(ep.stepsDone, 11);
  assert.equal(ep.video, `/media/${id}/final.mp4`);
  assert.ok(ep.lines.length > 0);
});

test("ролик доступен по публичной ссылке без пароля", async () => {
  const res = await fetch(`${base}/media/${id}/final.mp4`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "video/mp4");
});

test("кнопки интерфейса меняют статус серии", async () => {
  const res = await fetch(`${base}/api/episodes/${id}/reject`, { method: "POST", headers: auth });
  assert.equal(res.status, 202);
  assert.equal(loadEpisode(id).status, "rejected");
  const denied = await fetch(`${base}/api/episodes/${id}/reject`, { method: "POST" });
  assert.equal(denied.status, 401);
});

test("превью собирает интерфейс с данными и роликами рядом", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ai-studio-preview-"));
  const result = buildPreview(out);
  const html = fs.readFileSync(result.page, "utf8");
  assert.ok(html.includes("window.STUDIO_PREVIEW = "));
  assert.ok(result.media.includes(`media/${id}/final.mp4`));
  assert.ok(fs.existsSync(path.join(out, "media", id, "final.mp4")));
});

test("бренд для компании: Дизайнер маскотов собирает сериал, потом серия по заданию", async () => {
  const res = await fetch(`${base}/api/brands`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ company: "Lazzat Somsa", product: "Самса из тандыра", language: "uz" }),
  });
  assert.equal(res.status, 202);
  const { loadSeries } = await import("../src/store.js");
  let brand;
  for (let i = 0; i < 50 && !brand; i++) {
    try {
      brand = loadSeries("lazzat-somsa");
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(brand, "бренд не появился");
  assert.equal(brand.client?.company, "Lazzat Somsa");
  assert.ok(brand.characters.every((c) => c.voice.azure?.startsWith("uz-UZ-")));

  const bad = await fetch(`${base}/api/brands`, { method: "POST", headers: auth, body: new URLSearchParams({ company: "" }) });
  assert.equal(bad.status, 400);

  const start = await fetch(`${base}/api/episodes`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ series: "lazzat-somsa", brief: "Серия к Наврузу", engine: "mock" }),
  });
  assert.equal(start.status, 202);
  const { id: newId } = (await start.json()) as { id: string };
  let ep = loadEpisode(newId);
  for (let i = 0; i < 300 && ep.status === "in_progress"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    ep = loadEpisode(newId);
  }
  assert.equal(ep.status, "awaiting_approval", ep.error);
  assert.equal(ep.brief, "Серия к Наврузу");
  assert.equal(ep.engines?.video, "mock");
  assert.ok(ep.idea?.title.includes("Наврузу"));

  const noKey = await fetch(`${base}/api/episodes`, { method: "POST", headers: auth, body: new URLSearchParams({ engine: "grok" }) });
  assert.equal(noKey.status, 400);
  assert.match(((await noKey.json()) as { error: string }).error, /Grok не подключён/);
});
