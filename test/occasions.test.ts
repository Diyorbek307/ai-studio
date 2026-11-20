import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isolate } from "./helpers.js";

const dataDir = isolate();
const { upcomingOccasions, pickOccasion, occasionDates, allOccasions } = await import("../src/occasions.js");
const { createEpisode, saveEpisode } = await import("../src/store.js");

test("даты поводов: каждый год, по лунному календарю и «Чёрная пятница»", () => {
  const byId = new Map(allOccasions().map((o) => [o.id, o]));
  assert.deepEqual(occasionDates(byId.get("navruz")!, 2027), ["2027-03-21"]);
  assert.deepEqual(occasionDates(byId.get("black-friday")!, 2026), ["2026-11-27"]);
  assert.deepEqual(occasionDates(byId.get("black-friday")!, 2027), ["2027-11-26"]);
  assert.deepEqual(occasionDates(byId.get("qurbon-hayit")!, 2027), ["2027-05-17"]);
  assert.deepEqual(occasionDates(byId.get("qurbon-hayit")!, 2030), []); // неизвестный год — пропускаем, а не угадываем
});

test("ближайшие поводы по порядку, с переходом через Новый год", () => {
  const list = upcomingOccasions("2026-12-20", 30);
  assert.deepEqual(list.map((o) => [o.id, o.date, o.daysLeft]), [
    ["new-year", "2027-01-01", 12],
    ["defenders", "2027-01-14", 25],
  ]);
});

test("автопилот берёт повод за несколько дней и только один раз на сериал", () => {
  assert.equal(pickOccasion("bozor-seriali", "2026-11-20"), undefined); // до Чёрной пятницы ещё 7 дней
  const bf = pickOccasion("bozor-seriali", "2026-11-25");
  assert.equal(bf?.key, "black-friday:2026");

  const ep = createEpisode("bozor-seriali", { brief: bf!.brief });
  ep.occasion = bf!.key;
  saveEpisode(ep);
  assert.equal(pickOccasion("bozor-seriali", "2026-11-25"), undefined);
  assert.equal(pickOccasion("other-brand", "2026-11-25")?.key, "black-friday:2026"); // у другого сериала — своя серия

  ep.status = "rejected";
  saveEpisode(ep);
  assert.equal(pickOccasion("bozor-seriali", "2026-11-25")?.key, "black-friday:2026"); // отклонённая не считается
});

test("свои даты клиента из data/occasions.json", () => {
  fs.writeFileSync(
    path.join(dataDir, "occasions.json"),
    JSON.stringify({ items: [{ id: "lazzat-birthday", name: "Lazzat Somsa 5 yosh", dates: ["12-03"], brief: "Серия ко дню рождения сети Lazzat Somsa", leadDays: 2, series: ["lazzat-somsa"] }] }),
  );
  assert.equal(pickOccasion("lazzat-somsa", "2026-12-01")?.id, "lazzat-birthday");
  assert.equal(pickOccasion("lazzat-somsa", "2026-11-30"), undefined);
  assert.equal(pickOccasion("bozor-seriali", "2026-12-01"), undefined); // чужой день рождения не берём
});
