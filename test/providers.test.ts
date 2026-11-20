import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isolate } from "./helpers.js";

// Ключи-заглушки: настоящие API не вызываются, fetch подменён ответами в формате из официальной документации.
isolate({
  GEMINI_API_KEY: "g-test",
  XAI_API_KEY: "x-test",
  HIGGSFIELD_KEY_ID: "id",
  HIGGSFIELD_KEY_SECRET: "secret",
  IMAGE_ENGINE: "auto",
  VIDEO_ENGINE: "auto",
});

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
const calls: Call[] = [];
let routes: ((c: Call) => unknown | undefined)[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  let body: unknown = init?.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      /* не JSON */
    }
  }
  const call = { url, method: init?.method ?? "GET", headers, body };
  calls.push(call);
  for (const route of routes) {
    const reply = route(call);
    if (reply !== undefined) {
      if (reply instanceof Response) return reply;
      return new Response(JSON.stringify(reply), { headers: { "Content-Type": "application/json" } });
    }
  }
  return realFetch(input, init);
}) as typeof fetch;

const { grokVideo, grokImage } = await import("../src/providers/grok.js");
const { geminiVideo, geminiImage } = await import("../src/providers/gemini.js");
const { higgsfieldVideo } = await import("../src/providers/higgsfield.js");
const { resolveEngine } = await import("../src/providers/engines.js");

test("Grok: видео по кадру 9:16 без звука, ждём done, стоимость из тиков", async () => {
  calls.length = 0;
  let polls = 0;
  routes = [
    (c) => (c.url === "https://api.x.ai/v1/videos/generations" ? { request_id: "r1" } : undefined),
    (c) =>
      c.url === "https://api.x.ai/v1/videos/r1"
        ? ++polls < 2
          ? { status: "pending", progress: 40 }
          : { status: "done", video: { url: "https://vidgen.x.ai/v.mp4", duration: 6, respect_moderation: true }, usage: { cost_in_usd_ticks: 5_000_000_000 } }
        : undefined,
  ];
  const out = await grokVideo({ imageDataUri: "data:image/png;base64,AAAA", prompt: "Qovun opa waves", seconds: 6.4 });
  assert.equal(out.url, "https://vidgen.x.ai/v.mp4");
  assert.equal(out.costUsd, 0.5);
  const start = calls[0]!;
  assert.equal(start.headers.authorization, "Bearer x-test");
  assert.deepEqual(start.body, {
    model: "grok-imagine-video-1.5",
    prompt: "Qovun opa waves",
    image: { url: "data:image/png;base64,AAAA" },
    duration: 6,
    aspect_ratio: "9:16",
    resolution: "720p",
    generate_audio: false,
  });
});

test("Grok: модерация и ошибка генерации понятны человеку", async () => {
  routes = [
    (c) => (c.url.endsWith("/videos/generations") ? { request_id: "r2" } : undefined),
    (c) => (c.url.endsWith("/videos/r2") ? { status: "done", video: { url: "", respect_moderation: false } } : undefined),
  ];
  await assert.rejects(grokVideo({ imageDataUri: "data:,", prompt: "x", seconds: 5 }), /модерацию/);
  routes = [
    (c) => (c.url.endsWith("/videos/generations") ? { request_id: "r3" } : undefined),
    (c) => (c.url.endsWith("/videos/r3") ? { status: "failed", error: { code: "internal_error", message: "boom" } } : undefined),
  ];
  await assert.rejects(grokVideo({ imageDataUri: "data:,", prompt: "x", seconds: 5 }), /boom/);
});

test("Grok: картинка 9:16 в base64", async () => {
  routes = [(c) => (c.url.endsWith("/images/generations") ? { data: [{ b64_json: Buffer.from("png").toString("base64") }], usage: { cost_in_usd_ticks: 200_000_000 } } : undefined)];
  const out = await grokImage("bazaar");
  assert.equal(out.bytes?.toString(), "png");
  assert.equal(out.costUsd, 0.02);
  assert.equal((calls.at(-1)!.body as { aspect_ratio: string }).aspect_ratio, "9:16");
});

test("Gemini: видео Omni Flash — кадр + описание, 9:16, длина в секундах, файл из steps", async () => {
  calls.length = 0;
  routes = [
    (c) =>
      c.url === "https://generativelanguage.googleapis.com/v1beta/interactions"
        ? {
            status: "completed",
            steps: [
              { type: "user_input", content: [{ type: "text", text: "..." }] },
              { type: "model_output", content: [{ type: "video", mime_type: "video/mp4", data: Buffer.from("mp4").toString("base64") }] },
            ],
          }
        : undefined,
  ];
  const out = await geminiVideo({ imageBase64: "QUJD", prompt: "Somsa aka laughs", seconds: 4.6 });
  assert.equal(out.bytes?.toString(), "mp4");
  const body = calls[0]!.body as { model: string; input: { type: string }[]; response_format: Record<string, string> };
  assert.equal(calls[0]!.headers["x-goog-api-key"], "g-test");
  assert.equal(body.model, "gemini-omni-1.2-flash");
  assert.deepEqual(body.input[0], { type: "image", data: "QUJD", mime_type: "image/png" });
  assert.deepEqual(body.response_format, { type: "video", aspect_ratio: "9:16", duration: "5s" });
});

test("Gemini: картинка Nano Banana с ревизией API и понятная ошибка", async () => {
  calls.length = 0;
  routes = [
    (c) =>
      c.url.endsWith("/v1beta/interactions")
        ? { status: "completed", steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/png", data: Buffer.from("img").toString("base64") }] }] }
        : undefined,
  ];
  const out = await geminiImage("bazaar");
  assert.equal(out.bytes?.toString(), "img");
  assert.equal(calls[0]!.headers["api-revision"], "2026-05-20");
  routes = [(c) => (c.url.endsWith("/v1beta/interactions") ? new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 }) : undefined)];
  await assert.rejects(geminiImage("bazaar"), /429 quota/);
});

test("Higgsfield: кадр загружается в их хранилище без наших ключей, потом Kling 3.0 без звука", async () => {
  calls.length = 0;
  const frame = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hf-")), "s1.png");
  fs.writeFileSync(frame, "png-bytes");
  routes = [
    (c) =>
      c.url === "https://api.higgsfield.ai/files/generate-upload-url"
        ? { public_url: "https://cdn.hf/in.png", upload_url: "https://storage.hf/put?sig=1", content_type: "image/png", upload_headers: { "Content-Type": "image/png" } }
        : undefined,
    (c) => (c.url === "https://storage.hf/put?sig=1" ? new Response("", { status: 200 }) : undefined),
    (c) =>
      c.url === "https://api.higgsfield.ai/kling-video/v3.0/std/image-to-video"
        ? { status: "queued", request_id: "h1", status_url: "https://api.higgsfield.ai/requests/h1/status" }
        : undefined,
    (c) => (c.url === "https://api.higgsfield.ai/requests/h1/status" ? { status: "completed", request_id: "h1", video: { url: "https://cdn.hf/out.mp4" } } : undefined),
  ];
  const out = await higgsfieldVideo({ image: frame, prompt: "Non bobo nods", seconds: 2.2 });
  assert.equal(out.url, "https://cdn.hf/out.mp4");
  const put = calls.find((c) => c.method === "PUT")!;
  assert.equal(put.headers.authorization, undefined);
  const submit = calls.find((c) => c.url.endsWith("/image-to-video"))!;
  assert.equal(submit.headers.authorization, "Key id:secret");
  assert.deepEqual(submit.body, { prompt: "Non bobo nods", image_url: "https://cdn.hf/in.png", duration: 3, sound: "off" });
});

test("выбор движка: явный без ключа — ошибка, авто — первый подключённый", async () => {
  assert.equal(resolveEngine("auto", "video"), "gemini");
  assert.equal(resolveEngine("grok", "video"), "grok");
  assert.throws(() => resolveEngine("fal", "video"), /fal\.ai не подключён/);
});
