import { animateScenes } from "./agents/animator.js";
import { requestApproval, sendToClient } from "./agents/approvalConsole.js";
import { designSeries } from "./agents/characterDesigner.js";
import { buildShots } from "./agents/consistencyKeeper.js";
import { editEpisode } from "./agents/editor.js";
import { applyHook, makeHook } from "./agents/hookMaster.js";
import { generateIdea } from "./agents/ideaGenerator.js";
import { agentInfo } from "./agents/index.js";
import { drawKeyframes } from "./agents/keyframeGenerator.js";
import { publishEpisode } from "./agents/publisher.js";
import { checkQuality } from "./agents/qualityController.js";
import { writeScript } from "./agents/scriptwriter.js";
import { analyzeStats, collectStats } from "./agents/statsAnalyst.js";
import { addSubtitles } from "./agents/subtitler.js";
import { voiceEpisode } from "./agents/voiceUz.js";
import { assertBudget, BudgetExceededError, budgetSummary, localDay } from "./budget.js";
import { audit } from "./audit.js";
import { autopilotDue, clientForBrand, listClients } from "./clients.js";
import { config } from "./config.js";
import { sendMessage, telegramEnabled } from "./integrations/telegram.js";
import { isEngine, resolveEngine } from "./providers/engines.js";
import { errorMessage, log } from "./log.js";
import { createEpisode, listEpisodes, loadEpisode, loadInsights, loadSeries, saveEpisode, saveState } from "./store.js";
import type { ApprovalEntry, Episode, QaReport, Series } from "./types.js";

const PRODUCER = agentInfo(99);

/** Шаги конвейера по порядку. Озвучка идёт до анимации: длина клипа зависит от длины реплик. */
export const STEPS = ["idea", "script", "hook", "shots", "keyframes", "voice", "clips", "edit", "subtitles", "qa", "approval"] as const;
export type Step = (typeof STEPS)[number];

const OUTPUTS: Record<Step, (keyof Episode)[]> = {
  idea: ["idea", "ideaAlternatives"],
  script: ["script"],
  hook: ["hook"],
  shots: ["shots"],
  keyframes: ["keyframes"],
  voice: ["voice"],
  clips: ["clips"],
  edit: ["edited"],
  subtitles: ["final", "subtitles"],
  qa: ["qa"],
  approval: ["approval"],
};

export function isStepDone(ep: Episode, step: Step): boolean {
  switch (step) {
    case "idea":
      return !!ep.idea;
    case "script":
      return !!ep.script;
    case "hook":
      return !!ep.hook;
    case "shots":
      return !!ep.shots;
    case "keyframes":
      return !!ep.shots && !!ep.keyframes && ep.shots.every((s) => ep.keyframes![s.scene_id]);
    case "voice":
      return !!ep.voice;
    case "clips":
      return !!ep.voice && !!ep.clips && ep.voice.scenes.every((s) => ep.clips![s.sceneId]);
    case "edit":
      return !!ep.edited;
    case "subtitles":
      return !!ep.final;
    case "qa":
      return !!ep.qa;
    case "approval":
      return !!ep.approval?.requestedAt;
  }
}

export function nextStep(ep: Episode): Step | undefined {
  return STEPS.find((s) => !isStepDone(ep, s));
}

/** Стирает результаты шага и всех шагов после него — с этого места конвейер пойдёт заново. */
export function resetFrom(ep: Episode, step: Step): void {
  for (const s of STEPS.slice(STEPS.indexOf(step))) {
    for (const field of OUTPUTS[s]) delete ep[field];
  }
}

/** С какого шага переделывать после неудачной проверки качества (undefined — не переделывать). */
export function qaRedoStep(qa: QaReport): Step | undefined {
  if (qa.tech.problems.length > 0) return "edit";
  switch (qa.review.redo_from) {
    case "script":
      return "script";
    case "shots":
      return "shots";
    case "voice":
      return "voice";
    case "edit":
      return "edit";
    case "none":
      return undefined;
  }
}

// Один эпизод за раз: запросы из Telegram, панели и расписания встают в очередь.
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function notify(text: string): Promise<void> {
  if (!telegramEnabled()) return;
  try {
    await sendMessage(config.telegram.adminChatId, text);
  } catch (error) {
    log.warn(`Не удалось написать в Telegram: ${errorMessage(error)}`);
  }
}

async function runStep(ep: Episode, series: Series, step: Step): Promise<Series> {
  switch (step) {
    case "idea": {
      const recentTitles = listEpisodes()
        .filter((e) => e.series === series.slug && e.id !== ep.id && e.script)
        .slice(0, 15)
        .map((e) => e.script!.title);
      const result = await generateIdea({ series, recentTitles, insights: loadInsights(series.slug), brief: ep.brief, episodeId: ep.id });
      ep.idea = result.idea;
      ep.ideaAlternatives = result.alternatives;
      break;
    }
    case "script":
      ep.script = await writeScript({ series, idea: ep.idea!, feedback: ep.feedback, episodeId: ep.id });
      break;
    case "hook": {
      const hook = await makeHook({ series, script: ep.script!, episodeId: ep.id });
      ep.hook = hook;
      ep.script = applyHook(ep.script!, hook);
      break;
    }
    case "shots":
      series = await designSeries(series);
      ep.shots = await buildShots({ series, script: ep.script!, episodeId: ep.id });
      break;
    case "keyframes":
      await drawKeyframes(ep, series);
      break;
    case "voice":
      ep.voice = await voiceEpisode(ep, series);
      break;
    case "clips":
      await animateScenes(ep, series);
      break;
    case "edit":
      ep.edited = await editEpisode(ep);
      break;
    case "subtitles": {
      const out = await addSubtitles(ep);
      ep.final = out.final;
      ep.subtitles = out.subtitles;
      break;
    }
    case "qa":
      ep.qa = await checkQuality(ep, series);
      break;
    case "approval":
      await requestApproval(ep, series);
      break;
  }
  return series;
}

async function drive(ep: Episode): Promise<void> {
  let series = loadSeries(ep.series);
  for (let guard = 0; guard < 40; guard++) {
    const step = nextStep(ep);
    if (!step) return;
    ep.step = step;
    saveEpisode(ep);
    if (step !== "approval") assertBudget();
    log.agent(PRODUCER, `${ep.id}: шаг «${step}»`);

    series = await runStep(ep, series, step);
    saveEpisode(ep);

    if (step === "qa" && ep.qa && !ep.qa.pass) {
      const redo = qaRedoStep(ep.qa);
      const tries = (ep.attempts.qa ?? 0) + 1;
      ep.attempts.qa = tries;
      if (redo && tries <= config.maxQaRetries) {
        const notes = [...ep.qa.tech.problems, ...ep.qa.review.issues.map((i) => i.note)].join("; ");
        ep.feedback.push(`Контролёр качества: ${notes}`);
        log.agent(PRODUCER, `переделываю с шага «${redo}» (попытка ${tries} из ${config.maxQaRetries})`);
        resetFrom(ep, redo);
        saveEpisode(ep);
      }
      // Попытки кончились — ролик всё равно уходит тебе, с пометкой о замечаниях.
    }
  }
  throw new Error("Конвейер зациклился — проверь эпизод вручную");
}

/** Ведёт эпизод от текущего шага до отправки на одобрение. */
export function runEpisode(id: string): Promise<Episode> {
  return exclusive(async () => {
    const ep = loadEpisode(id);
    if (["approved", "published", "rejected"].includes(ep.status)) return ep;
    if (!nextStep(ep)) {
      // Все шаги уже сделаны — ролик ждёт решения, ничего не переделываем.
      if (ep.status !== "awaiting_feedback" && ep.status !== "awaiting_client") ep.status = "awaiting_approval";
      saveEpisode(ep);
      return ep;
    }
    ep.status = "in_progress";
    delete ep.error;
    saveEpisode(ep);
    try {
      await drive(ep);
      log.agent(PRODUCER, `${ep.id}: готов, ждёт одобрения · ${budgetSummary()}`);
    } catch (error) {
      ep.error = errorMessage(error);
      ep.status = error instanceof BudgetExceededError ? "paused_budget" : "failed";
      log.error(`${ep.id} остановлен на шаге «${ep.step}»: ${ep.error}`);
      await notify(
        ep.status === "paused_budget"
          ? `⏸ ${ep.id}: ${ep.error}. Продолжу, когда появится бюджет.`
          : `❌ ${ep.id} остановился на шаге «${ep.step}»: ${ep.error}`,
      );
    }
    saveEpisode(ep);
    return ep;
  });
}

/** Проверки до запуска, чтобы не создавать эпизод, который сразу упадёт. */
export function prepareEpisode(series = config.series, opts: { brief?: string; engine?: string; orderedBy?: string } = {}): Episode {
  loadSeries(series); // упадёт сразу, если сериала нет
  if (opts.engine && opts.engine !== "auto") {
    if (!isEngine(opts.engine)) throw new Error(`Нет движка «${opts.engine}»`);
    resolveEngine(opts.engine, "video"); // упадёт, если у движка нет ключа
  }
  const ep = createEpisode(series, opts);
  if (opts.orderedBy) {
    ep.orderedBy = opts.orderedBy;
    saveEpisode(ep);
  }
  log.agent(PRODUCER, `новый эпизод ${ep.id} (${series})${ep.brief ? ` — задание: «${ep.brief}»` : ""}`);
  return ep;
}

export async function newEpisode(series = config.series, opts: { brief?: string; engine?: string; orderedBy?: string } = {}): Promise<Episode> {
  return runEpisode(prepareEpisode(series, opts).id);
}

/** Кто принимает решение по ролику: команда студии или компания-клиент (только по своему бренду). */
export type Decider = { by: "studio" } | { by: "client"; clientId: string };
const STUDIO: Decider = { by: "studio" };

function logDecision(ep: Episode, by: ApprovalEntry["by"], decision: ApprovalEntry["decision"], note?: string): void {
  ep.approvalLog = [...(ep.approvalLog ?? []), { ts: new Date().toISOString(), by, decision, ...(note ? { note } : {}) }];
}

/** Клиент решает только по роликам своего бренда, которые ждут именно его. */
function assertClientTurn(ep: Episode, who: Decider): void {
  if (who.by !== "client") return;
  const client = clientForBrand(ep.series);
  if (!client || client.id !== who.clientId) throw new Error("Нет доступа к этой серии");
  if (ep.status !== "awaiting_client") throw new Error("Эта серия сейчас не ждёт вашего решения");
}

/**
 * Одобрение. Студия при порядке «студия, затем клиент» передаёт ролик клиенту;
 * клиент (или студия за клиента) одобряет окончательно — и ролик уходит в Instagram.
 */
export function approveEpisode(id: string, who: Decider = STUDIO): Promise<Episode> {
  return exclusive(async () => {
    const ep = loadEpisode(id);
    assertClientTurn(ep, who);
    if (!["awaiting_approval", "awaiting_client", "approved"].includes(ep.status)) {
      throw new Error(`${id}: одобрить можно только ролик, который ждёт одобрения (сейчас: ${ep.status})`);
    }
    const client = clientForBrand(ep.series);
    if (who.by === "studio" && ep.status === "awaiting_approval" && client?.approval === "studio_then_client") {
      logDecision(ep, "studio", "approved");
      await sendToClient(ep, client);
      saveEpisode(ep);
      audit("Студия", "передала серию клиенту", ep.id, client.company);
      return ep;
    }

    const note = who.by === "studio" && ep.status === "awaiting_client" ? "за клиента" : undefined;
    if (ep.status !== "approved") logDecision(ep, who.by, "approved", note);
    ep.approval = { ...ep.approval, decision: "approved", decidedAt: new Date().toISOString() };
    ep.status = "approved";
    saveEpisode(ep);
    audit(who.by === "client" ? (client?.company ?? "Клиент") : "Студия", "одобрил(а) серию", ep.id, note);
    try {
      ep.publish = await publishEpisode(ep);
      ep.status = ep.publish.dryRun ? "approved" : "published";
      delete ep.error;
    } catch (error) {
      ep.error = `Публикация не удалась: ${errorMessage(error)}`;
      log.error(ep.error);
    }
    saveEpisode(ep);
    return ep;
  });
}

export function rejectEpisode(id: string): Promise<Episode> {
  return exclusive(async () => {
    const ep = loadEpisode(id);
    if (ep.status === "published") throw new Error(`${id} уже опубликован`);
    ep.approval = { ...ep.approval, decision: "rejected", decidedAt: new Date().toISOString() };
    ep.status = "rejected";
    logDecision(ep, "studio", "rejected");
    saveEpisode(ep);
    audit("Студия", "отклонила серию", ep.id);
    log.agent(PRODUCER, `${id}: отклонён`);
    return ep;
  });
}

/** Ждём текст правок (Telegram: после кнопки «Переделать») — от студии или от клиента. */
export function markAwaitingFeedback(id: string, who: Decider = STUDIO): Episode {
  const ep = loadEpisode(id);
  assertClientTurn(ep, who);
  ep.status = "awaiting_feedback";
  ep.feedbackFrom = who.by;
  saveEpisode(ep);
  return ep;
}

/** Переделать с шага (по умолчанию со сценария) с учётом замечаний студии или клиента. */
export async function redoEpisode(id: string, feedback: string, from: Step = "script", who: Decider = STUDIO): Promise<Episode> {
  await exclusive(async () => {
    const ep = loadEpisode(id);
    if (ep.status === "published") throw new Error(`${id} уже опубликован`);
    if (who.by === "client") {
      // Клиент просит правки по ролику, который ждёт его (или уже ждёт его текст после кнопки в Telegram).
      const client = clientForBrand(ep.series);
      if (!client || client.id !== who.clientId) throw new Error("Нет доступа к этой серии");
      const waiting = ep.status === "awaiting_client" || (ep.status === "awaiting_feedback" && ep.feedbackFrom === "client");
      if (!waiting) throw new Error("Эта серия сейчас не ждёт вашего решения");
      if (!feedback.trim()) throw new Error("Напишите, что поменять в серии");
    }
    const text = feedback.trim();
    if (text) ep.feedback.push(`${who.by === "client" ? "Клиент" : "Продюсер"}: ${text}`);
    logDecision(ep, who.by, "redo", text || undefined);
    ep.approval = { ...ep.approval, decision: "redo", decidedAt: new Date().toISOString() };
    ep.attempts = {};
    delete ep.feedbackFrom;
    resetFrom(ep, from);
    ep.status = "in_progress";
    saveEpisode(ep);
    if (who.by === "client") audit(clientForBrand(ep.series)?.company ?? "Клиент", "попросил(а) правки", ep.id, text);
    log.agent(PRODUCER, `${id}: переделываю с шага «${from}»`);
  });
  return runEpisode(id);
}

/** Ежедневный цикл: цифры → выводы → дособрать отложенные → новые серии. */
export async function dailyJob(seriesSlug = config.series): Promise<Episode[]> {
  log.agent(PRODUCER, `ежедневный запуск (${seriesSlug})`);
  const series = loadSeries(seriesSlug);
  try {
    await collectStats(seriesSlug);
    await analyzeStats(series);
  } catch (error) {
    log.warn(`Аналитика: ${errorMessage(error)}`);
  }

  const results: Episode[] = [];
  for (const paused of listEpisodes().filter((e) => e.series === seriesSlug && e.status === "paused_budget")) {
    results.push(await runEpisode(paused.id));
  }
  for (let i = 0; i < config.schedule.episodesPerDay; i++) {
    const ep = await newEpisode(seriesSlug);
    results.push(ep);
    if (ep.status === "paused_budget") break;
  }
  saveState({ lastDailyRun: localDay() });
  return results;
}

/**
 * Автопилот клиентов: каждому активному клиенту — столько серий, чтобы тариф расходовался ровно по периоду
 * (Старт — 12 в месяц, Бизнес — каждый день, Сеть — по 2 в день). Серии по заданиям клиента тоже засчитываются.
 */
export async function clientsAutopilot(): Promise<Episode[]> {
  const results: Episode[] = [];
  for (const client of listClients()) {
    for (let n = autopilotDue(client); n > 0; n--) {
      const ep = await newEpisode(client.brand, { orderedBy: "Автопилот" });
      results.push(ep);
      if (ep.status === "paused_budget") return results;
    }
  }
  return results;
}

/** Ежедневный цикл всей студии: свой сериал (если он не клиентский), затем бренды клиентов и их автопилот. */
export async function dailyAll(): Promise<Episode[]> {
  const results = clientForBrand(config.series) ? [] : await dailyJob(config.series);
  for (const client of listClients().filter((c) => c.status === "active")) {
    try {
      await collectStats(client.brand);
      await analyzeStats(loadSeries(client.brand));
    } catch (error) {
      log.warn(`Аналитика «${client.company}»: ${errorMessage(error)}`);
    }
    for (const paused of listEpisodes().filter((e) => e.series === client.brand && e.status === "paused_budget")) {
      results.push(await runEpisode(paused.id));
    }
  }
  results.push(...(await clientsAutopilot()));
  saveState({ lastDailyRun: localDay() });
  return results;
}
