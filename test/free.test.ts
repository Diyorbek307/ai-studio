import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { isolate } from "./helpers.js";

// Бесплатный старт: только ключ Gemini (провайдеры как при пустом .env, кроме демо-режима из isolate). Текст и голос — бесплатный тариф Gemini, кадры и видео — перекладка.
// fetch подменён ответами в формате из документации Google, настоящий API не вызывается.
const dataDir = isolate({
  GEMINI_API_KEY: "g-free",
  LLM_PROVIDER: "gemini",
  IMAGE_ENGINE: "auto",
  VIDEO_ENGINE: "auto",
  TTS_PROVIDER: "gemini",
});

// Настоящий WAV на 1.2 секунды — как вернул бы Gemini TTS (24 кГц, моно).
const wavFile = path.join(dataDir, "tts.wav");
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=1.2", "-ar", "24000", "-ac", "1", wavFile]);
const wavB64 = fs.readFileSync(wavFile).toString("base64");

type Call = { url: string; body: any; headers: Record<string, string> };
const calls: Call[] = [];
let textReply: () => unknown = () => ({});
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  calls.push({ url, body, headers });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  if (url.includes("-tts:generateContent")) {
    return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: wavB64 } }] } }] });
  }
  if (url.includes(":generateContent")) return json(textReply());
  throw new Error(`неожиданный запрос ${url}`);
}) as typeof fetch;

const { config } = await import("../src/config.js");
const { askStructured } = await import("../src/llm.js");
const { speak } = await import("../src/providers/tts.js");
const { resolveEngine, engineStatus } = await import("../src/providers/engines.js");
const { agentInfo } = await import("../src/agents/index.js");

test("только ключ Gemini: мозг и голос Gemini, кадры — бесплатная перекладка", () => {
  assert.equal(config.llm.provider, "gemini");
  assert.equal(config.tts.provider, "gemini");
  assert.equal(resolveEngine("auto", "image"), "cutout");
  assert.equal(resolveEngine(undefined, "video"), "cutout");
  const cutout = engineStatus().find((e) => e.engine === "cutout");
  assert.deepEqual(cutout, { engine: "cutout", label: "Перекладка", available: true, free: true });
  assert.equal(engineStatus().find((e) => e.engine === "gemini")?.available, false);
});

test("Gemini-мозг: строгий JSON по схеме, мысли пропускаются, расход $0", async () => {
  calls.length = 0;
  textReply = () => ({
    candidates: [
      {
        content: { parts: [{ text: "думаю…", thought: true }, { text: '{"title":"Qovun opa', }, { text: ' va bozor","jokes":2}' }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300, thoughtsTokenCount: 50 },
  });
  const schema = z.object({ title: z.string(), jokes: z.number() });
  const out = await askStructured({
    agent: agentInfo(7),
    system: "Ты сценарист.",
    context: "Канон сериала.",
    prompt: "Придумай серию.",
    schema,
    effort: "high",
    mock: () => ({ title: "демо", jokes: 0 }),
  });
  assert.deepEqual(out, { title: "Qovun opa va bozor", jokes: 2 });

  const call = calls[0]!;
  assert.match(call.url, /models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(call.headers["x-goog-api-key"], "g-free");
  assert.equal(call.body.system_instruction.parts[0].text, "Ты сценарист.\n\nКанон сериала.");
  assert.equal(call.body.generationConfig.responseFormat.text.mimeType, "APPLICATION_JSON");
  assert.equal(call.body.generationConfig.responseFormat.text.schema.type, "object");
  assert.equal(call.body.generationConfig.responseFormat.text.schema.additionalProperties, undefined);
  assert.equal(call.body.generationConfig.thinkingConfig.thinkingLevel, "high");

  // Бесплатный тариф: в журнал расходов ничего не пишется.
  assert.equal(fs.existsSync(path.join(dataDir, "costs.jsonl")), false);
});

test("Gemini-мозг: ошибка Google массивом и отказ фильтра — понятные ошибки", async () => {
  const schema = z.object({ ok: z.boolean() });
  const base = { agent: agentInfo(7), system: "s", prompt: "p", schema, mock: () => ({ ok: true }) };
  textReply = () => [{ error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } }];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await orig(input, init);
    return String(input).includes("tts") ? res : new Response(await res.text(), { status: 429 });
  }) as typeof fetch;
  await assert.rejects(askStructured(base), /429 Quota exceeded/);
  globalThis.fetch = orig;

  textReply = () => ({ candidates: [{ finishReason: "SAFETY" }] });
  await assert.rejects(askStructured(base), /фильтром безопасности/);
});

test("Gemini TTS: голос героя и эмоция реплики, на выходе WAV", async () => {
  calls.length = 0;
  const outBase = path.join(dataDir, "voice", "l1");
  const res = await speak({
    text: "Assalomu alaykum, bozorga xush kelibsiz!",
    language: "uz",
    voice: { azure: "uz-UZ-MadinaNeural", rate: "+0%", pitch: "+0Hz", gemini: "Leda", style: "тёплая, весёлая" },
    emotion: "радостно",
    outBase,
  });
  assert.equal(res.file, `${outBase}.wav`);
  assert.equal(res.costUsd, 0);
  assert.equal(fs.readFileSync(res.file).subarray(0, 4).toString(), "RIFF");
  const call = calls[0]!;
  assert.match(call.url, /models\/gemini-3\.8-flash-tts:generateContent$/);
  assert.deepEqual(call.body.generationConfig.responseModalities, ["AUDIO"]);
  assert.equal(call.body.generationConfig.speechConfig.voiceConfig.voice, "Leda");
  assert.equal(call.body.contents[0].parts[0].speech_metadata.style, "радостно; тёплая, весёлая");
});
