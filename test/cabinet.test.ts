import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { isolate } from "./helpers.js";

// Кабинет клиента целиком через HTTP: владелец подключает компанию, клиент входит по приглашению,
// заказывает серию, студия передаёт её клиенту, клиент просит правки и одобряет.
const dataDir = isolate({ STUDIO_ADMIN_PASSWORD: "owner-pass", PORT: "0" });
const { startServer } = await import("../src/server.js");
const { loadEpisode } = await import("../src/store.js");
const { characterAsset, isPlaceholder } = await import("../src/media/cutout.js");
type State = import("../src/studioState.js").StudioState;

let base = "";
let server: ReturnType<typeof startServer>;
const owner = { Authorization: "Basic " + Buffer.from("admin:owner-pass").toString("base64") };
let clientCookie = "";
let clientId = "";
let epId = "";

before(async () => {
  server = startServer();
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

function form(body: Record<string, string>): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) };
}
async function asOwner(url: string, body: Record<string, string> = {}): Promise<Response> {
  const init = form(body);
  return fetch(base + url, { ...init, headers: { ...(init.headers as Record<string, string>), ...owner } });
}
async function asClient(url: string, body: Record<string, string> = {}): Promise<Response> {
  const init = form(body);
  return fetch(base + url, { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: clientCookie } });
}
async function clientState(): Promise<State> {
  return (await (await fetch(base + "/api/state", { headers: { Cookie: clientCookie } })).json()) as State;
}
async function waitFor(check: () => boolean, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("не дождались");
    await new Promise((r) => setTimeout(r, 200));
  }
}

test("владелец подключает клиента и выдаёт ссылку в кабинет", async () => {
  const bad = await asOwner("/api/clients", { brand: "bozor-seriali", contactName: "Дилноза", email: "нет", plan: "start" });
  assert.equal(bad.status, 400);
  const res = await asOwner("/api/clients", { brand: "bozor-seriali", contactName: "Дилноза", email: "boss@bozor.uz", plan: "start" });
  assert.equal(res.status, 200);
  clientId = ((await res.json()) as { id: string }).id;

  const invite = (await (await asOwner(`/api/clients/${clientId}/invite`)).json()) as { url: string };
  const token = new URL(invite.url).pathname.split("/").pop()!;
  const page = await fetch(`${base}/invite/${token}`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('"mode":"invite"'));

  const accepted = await fetch(base + "/api/invite", form({ token, password: "client-pass-1" }));
  assert.equal(accepted.status, 200);
  clientCookie = accepted.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(clientCookie, /^studio_session=/);
  assert.equal((await fetch(`${base}/invite/${token}`)).status, 410); // второй раз ссылка не работает
});

test("вход: неверный пароль — 401, верный — cookie; запросы с чужого сайта отклоняются", async () => {
  assert.equal((await fetch(base + "/api/login", form({ login: "boss@bozor.uz", password: "wrong" }))).status, 401);
  const ok = await fetch(base + "/api/login", form({ login: "BOSS@bozor.uz", password: "client-pass-1" }));
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("set-cookie")!, /HttpOnly; SameSite=Lax/);
  const evil = await fetch(base + "/api/episodes", {
    ...form({ brief: "серия" }),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: clientCookie, Origin: "https://evil.example" },
  });
  assert.equal(evil.status, 403);
});

test("клиент видит только свой сериал, без расходов студии; чужие действия запрещены", async () => {
  const state = await clientState();
  assert.equal(state.role, "client");
  assert.deepEqual(state.brands.map((b) => b.slug), ["bozor-seriali"]);
  assert.equal(state.me?.planName, "Старт");
  assert.equal(state.me?.usage.limit, 12);
  assert.equal(state.agents.length, 0);
  assert.equal(state.clients, undefined);
  assert.ok(!JSON.stringify(state).includes("passwordHash"));

  assert.equal((await asClient("/api/clients", { brand: "x", contactName: "x", email: "x@x.uz", plan: "start" })).status, 403);
  assert.equal((await asClient("/api/brands", { company: "X", product: "Y" })).status, 403);
  assert.equal((await asClient("/api/daily")).status, 403);
  assert.equal((await asClient("/api/episodes", { brief: "?" })).status, 400); // пустое задание
});

test("клиент заказывает серию; пока её смотрит студия, клиент видит только «в работе»", async () => {
  const res = await asClient("/api/episodes", { brief: "Скидка 20% на самсу в пятницу", series: "chuzhoy-serial", engine: "grok" });
  assert.equal(res.status, 202);
  epId = ((await res.json()) as { id: string }).id;
  const ep = loadEpisode(epId);
  assert.equal(ep.series, "bozor-seriali"); // клиент не выбирает чужой сериал и платный движок
  assert.equal(ep.engineChoice, undefined);
  assert.equal(ep.orderedBy, "Bozor Seriali");
  await waitFor(() => loadEpisode(epId).status === "awaiting_approval");

  const mine = (await clientState()).episodes.find((e) => e.id === epId)!;
  assert.equal(mine.statusLabel, "⚙️ в работе у студии");
  assert.equal(mine.video, undefined);
  assert.equal(mine.lines.length, 0);
  assert.equal(mine.costUsd, 0);
  assert.equal((await asClient(`/api/episodes/${epId}/approve`)).status, 409); // ещё не её очередь
});

test("студия одобряет — серия у клиента; клиент просит правки — серия снова у студии", async () => {
  assert.equal((await asOwner(`/api/episodes/${epId}/approve`)).status, 202);
  await waitFor(() => loadEpisode(epId).status === "awaiting_client");
  const mine = (await clientState()).episodes.find((e) => e.id === epId)!;
  assert.equal(mine.statusLabel, "👀 ждёт вашего решения");
  assert.ok(mine.video);

  assert.equal((await asClient(`/api/episodes/${epId}/redo`, { feedback: "" })).status, 400);
  assert.equal((await asClient(`/api/episodes/${epId}/reject`)).status, 403);
  assert.equal((await asClient(`/api/episodes/${epId}/redo`, { feedback: "Добавьте в конце нашу акцию" })).status, 202);
  await waitFor(() => loadEpisode(epId).status === "awaiting_approval");
  assert.ok(loadEpisode(epId).feedback.includes("Клиент: Добавьте в конце нашу акцию"));
});

test("второй круг: студия → клиент → клиент одобряет, без Instagram клиента — к ручной публикации", async () => {
  await asOwner(`/api/episodes/${epId}/approve`);
  await waitFor(() => loadEpisode(epId).status === "awaiting_client");
  assert.equal((await asClient(`/api/episodes/${epId}/approve`)).status, 202);
  await waitFor(() => loadEpisode(epId).status === "approved");
  const ep = loadEpisode(epId);
  assert.equal(ep.publish?.dryRun, true);
  assert.match(ep.publish?.note ?? "", /Instagram клиента не подключён/);
  assert.deepEqual(
    ep.approvalLog?.map((a) => `${a.by}:${a.decision}`),
    ["studio:approved", "studio:sent_to_client", "client:redo", "studio:approved", "studio:sent_to_client", "client:approved"],
  );

  const owners = (await (await fetch(base + "/api/state", { headers: owner })).json()) as State;
  const card = owners.clients!.find((c) => c.id === clientId)!;
  assert.equal(card.usage.used, 1); // переделка не тратит вторую серию
  assert.equal(owners.invoices!.filter((i) => i.clientId === clientId).length, 1);
  assert.ok(owners.audit!.some((a) => a.actor === "Bozor Seriali" && a.action.startsWith("одобрил")));
});

test("заявка с сайта попадает владельцу; счёт отмечается оплаченным", async () => {
  assert.equal((await fetch(base + "/api/leads", form({ company: "Lazzat Somsa", name: "Дилноза", phone: "12" }))).status, 400);
  assert.equal((await fetch(base + "/api/leads", form({ company: "Lazzat Somsa", name: "Дилноза", phone: "+998901234567", plan: "business" }))).status, 200);
  let owners = (await (await fetch(base + "/api/state", { headers: owner })).json()) as State;
  assert.equal(owners.leads![0]!.company, "Lazzat Somsa");

  const inv = owners.invoices![0]!;
  assert.equal((await asOwner(`/api/invoices/${inv.id}/paid`, { paid: "1" })).status, 200);
  owners = (await (await fetch(base + "/api/state", { headers: owner })).json()) as State;
  assert.equal(owners.invoices![0]!.status, "paid");
  const me = (await clientState()).me!;
  assert.equal(me.invoices[0]!.status, "paid");
  assert.equal(me.unpaidUsd, 0);
});

test("картинка героя заменяет заглушку; клиент не видит картинки чужих брендов", async () => {
  const png = path.join(dataDir, "qovun.png");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=orange:s=300x450", "-frames:v", "1", png]);
  const notImage = await fetch(`${base}/api/brands/bozor-seriali/characters/qovun`, { method: "POST", headers: { ...owner, "Content-Type": "text/plain" }, body: "x" });
  assert.equal(notImage.status, 400);
  const up = await fetch(`${base}/api/brands/bozor-seriali/characters/qovun`, { method: "POST", headers: { ...owner, "Content-Type": "image/png" }, body: fs.readFileSync(png) });
  assert.equal(up.status, 200, await up.clone().text());
  const file = characterAsset("bozor-seriali", "qovun");
  assert.ok(fs.existsSync(file) && !isPlaceholder(file));

  const state = await clientState();
  const qovun = state.brands[0]!.characters.find((c) => c.id === "qovun")!;
  assert.equal(qovun.placeholder, false);
  const art = await fetch(base + qovun.art!, { headers: { Cookie: clientCookie } });
  assert.equal(art.status, 200);
  assert.equal(art.headers.get("content-type"), "image/png");
  assert.equal((await fetch(`${base}/assets/other-brand/characters/qovun.png`, { headers: { Cookie: clientCookie } })).status, 404);
  assert.equal((await asClient("/api/brands/bozor-seriali/characters/qovun")).status, 403);
});

test("смена пароля выдаёт новую сессию, выход стирает cookie", async () => {
  const res = await asClient("/api/me/password", { current: "client-pass-1", next: "client-pass-2" });
  assert.equal(res.status, 200);
  const fresh = res.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal((await fetch(base + "/api/state", { headers: { Cookie: clientCookie } })).status, 401); // старая сессия
  clientCookie = fresh;
  assert.equal((await clientState()).role, "client");
  const out = await fetch(base + "/api/logout", { method: "POST" });
  assert.match(out.headers.get("set-cookie")!, /Max-Age=0/);
});
