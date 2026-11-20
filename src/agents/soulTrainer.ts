import fs from "node:fs";
import { audit } from "../audit.js";
import { config } from "../config.js";
import { errorMessage, log } from "../log.js";
import { CHARACTER_VARIANTS, characterAsset, isPlaceholder } from "../media/cutout.js";
import { engineAvailable } from "../providers/engines.js";
import { soulStatus, trainSoulCharacter } from "../providers/higgsfield.js";
import { loadSeries, saveSeries } from "../store.js";
import type { Character } from "../types.js";
import { agentInfo } from "./index.js";

const AGENT = agentInfo(29);
const TERMINAL = new Set(["completed", "failed"]);

type SoulRef = NonNullable<Character["higgsfield_ref"]>;

function saveRef(slug: string, characterId: string, ref: SoulRef): void {
  const series = loadSeries(slug);
  const c = series.characters.find((x) => x.id === characterId);
  if (!c) return;
  c.higgsfield_ref = ref;
  saveSeries(series);
}

/**
 * Обучает героя в Higgsfield (Soul ID) по его картинкам: основная + «рот открыт» и «глаза закрыты», если есть.
 * После обучения SOUL рисует этого героя одинаковым в каждом кадре.
 */
export async function trainCharacter(slug: string, characterId: string): Promise<SoulRef> {
  if (!engineAvailable("higgsfield")) throw new Error("Higgsfield не подключён: добавь HIGGSFIELD_KEY_ID и HIGGSFIELD_KEY_SECRET");
  const series = loadSeries(slug);
  const c = series.characters.find((x) => x.id === characterId);
  if (!c) throw new Error(`Нет героя ${characterId}`);
  const base = characterAsset(slug, characterId);
  if (!fs.existsSync(base) || isPlaceholder(base)) throw new Error("Сначала загрузите картинку героя — по заглушке обучать нельзя");
  const images = [base, ...CHARACTER_VARIANTS.map((v) => characterAsset(slug, characterId, v)).filter((f) => fs.existsSync(f))];

  log.agent(AGENT, `обучаю героя «${c.name}» в Higgsfield по ${images.length} картинкам`);
  const created = await trainSoulCharacter(`${series.title}: ${c.name}`, images);
  const ref: SoulRef = { id: created.id, status: created.status, updatedAt: new Date().toISOString() };
  saveRef(slug, characterId, ref);
  audit("Студия", "начала обучение героя в Higgsfield", series.title, c.name);
  return ref;
}

/** Спрашивает у Higgsfield, как идёт обучение, и сохраняет статус в библию сериала. */
export async function refreshSoulStatus(slug: string, characterId: string): Promise<SoulRef | undefined> {
  const c = loadSeries(slug).characters.find((x) => x.id === characterId);
  if (!c?.higgsfield_ref) return undefined;
  const fresh = await soulStatus(c.higgsfield_ref.id);
  const ref: SoulRef = {
    id: c.higgsfield_ref.id,
    status: fresh.status,
    updatedAt: new Date().toISOString(),
    ...(fresh.fail_reason ? { failReason: fresh.fail_reason } : {}),
  };
  if (ref.status !== c.higgsfield_ref.status) {
    saveRef(slug, characterId, ref);
    if (ref.status === "completed") log.agent(AGENT, `герой «${c.name}» обучен — Higgsfield будет рисовать его по Soul ID`);
    if (ref.status === "failed") log.warn(`Higgsfield не обучил «${c.name}»: ${ref.failReason ?? "без причины"}`);
  }
  return ref;
}

/** Следит за обучением в фоне, пока оно не закончится (не дольше 3 часов). */
export function watchSoulTraining(slug: string, characterId: string, everyMs = config.pollMs * 12): Promise<SoulRef | undefined> {
  const deadline = Date.now() + 3 * 3600_000;
  return (async () => {
    for (;;) {
      await new Promise((r) => setTimeout(r, everyMs));
      try {
        const ref = await refreshSoulStatus(slug, characterId);
        if (!ref || TERMINAL.has(ref.status) || Date.now() > deadline) return ref;
      } catch (error) {
        log.warn(`Soul ID: ${errorMessage(error)}`);
        if (Date.now() > deadline) return undefined;
      }
    }
  })();
}
