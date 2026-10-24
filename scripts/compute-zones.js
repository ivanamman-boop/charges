// Карта зон (главный экран сайта): что даст стандартная станция РСЗС
// DC150-2 (150 кВт, 2 поста) в каждой шестиугольной зоне внутри МКАД и на
// каждой площадке пула (data/pool.json), по трём сценариям роста спроса.
//
// Для каждой точки - тот же модуль 6 (equipment.js evaluateCandidate, каталог
// из одной конфигурации), что и паспорт площадки на сайте: 12 локальных
// равновесий (2026, 2028, 2030 x зима/лето x будни/выходные) при сети
// соответствующего сценария, класс подключения, CAPEX и NPV в диапазоне цены
// подключения, простая и дисконтированная окупаемость. 2028 - третий опорный год
// (полное равновесие): городские станции открываются в 2027-2030, и
// интерполяция только между 2026 и 2030 завышала 2028 почти вдвое.
//
// Точка зоны: известная ТП 0.4 кВ (data/tp04.json) внутри зоны, ближайшая к
// её центру - станцию ставят у сети, и класс А в зоне возможен; если ТП в
// зоне нет - центр зоны (класс А|Б, считается как Б). Центр за МКАДом -
// заменяется центром ячеек спроса зоны.
//
// Запуск: npm run compute:zones  (-- --limit=20 для пробного прогона)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildNetworkContext, equilibrium } from '../js/equilibrium.js';
import { evaluateCandidate, yearAverage } from '../js/equipment.js';
import { stationsActiveIn } from '../js/demand.js';
import { dist04FromKnownTp } from '../js/grid.js';
import { hexKeyForLatLon, hexCenter, fromMercator, HEX_RADIUS_KM } from '../js/hex.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data');
const OUT_PATH = join(DATA, 'zones.json');
const read = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));

const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.slice(8) || Infinity);
const EQUIPMENT = 'DC150-2';
const SCENARIOS = ['base', 'fast'];
const YEARS = [2026, 2028, 2030]; // 2028 - опорный год: городские станции открываются в 2027-2030
const SEASONS = ['winter', 'summer'];
const DAY_TYPES = ['weekday', 'weekend'];

const cells = read('cells.json').cells;
const stationsAll = read('stations.json').stations;
const centers = read('centers.json').centers;
const tp04 = read('tp04.json').points;
const pool = read('pool.json').pool;
const ring = read('mkad.json').ring;
const params = read('params.json');
params.equilibrium = { ...params.equilibrium, convergence_threshold_hours: params.equilibrium.convergence_threshold_hours_precise };
params.M6_M7_equipment_economics.catalog.configs = params.M6_M7_equipment_economics.catalog.configs.filter((c) => c.omega === EQUIPMENT);

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 60000).toFixed(1)} мин`;

function insideMkad(lat, lon) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ai, bi] = ring[i];
    const [aj, bj] = ring[j];
    if (ai > lat !== aj > lat && lon < ((bj - bi) * (lat - ai)) / (aj - ai) + bi) inside = !inside;
  }
  return inside;
}

const distM = (aLat, aLon, bLat, bLon) => Math.hypot((aLat - bLat) * 111320, (aLon - bLon) * 111320 * Math.cos((aLat * Math.PI) / 180));

// Зоны - те же шестиугольники, что слой спроса на карте: только те, где есть ячейки спроса.
function buildZones() {
  const groups = new Map();
  for (const c of cells) {
    const key = hexKeyForLatLon(c.lat, c.lon);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return [...groups].map(([key, members]) => {
    let [lat, lon] = fromMercator(...hexCenter(key));
    if (!insideMkad(lat, lon)) {
      lat = members.reduce((a, c) => a + c.lat, 0) / members.length;
      lon = members.reduce((a, c) => a + c.lon, 0) / members.length;
    }
    // Ближайшая к центру известная ТП внутри зоны.
    let tp = null;
    let tpD = Infinity;
    for (const [la, lo] of tp04) {
      if (Math.abs(la - lat) > 0.01) continue;
      const d = distM(lat, lon, la, lo);
      if (d < tpD && d <= HEX_RADIUS_KM * 1000 * 0.85 && insideMkad(la, lo) && hexKeyForLatLon(la, lo) === key) {
        tpD = d;
        tp = [la, lo];
      }
    }
    const site = tp ? { lat: tp[0], lon: tp[1] } : { lat, lon };
    return { key, district: members[0].district, site, atTp: !!tp };
  });
}

const baselines = new Map();
function getBaselineFor(scenario) {
  return (year, season, dayType) => {
    const k = `${scenario}|${year}|${season}|${dayType}`;
    if (!baselines.has(k)) {
      const stations = stationsActiveIn(stationsAll, year, scenario, params);
      const context = buildNetworkContext({ cells, stations, params });
      const result = equilibrium({ cells, stations, params, year, scenario, dayType, season, context });
      baselines.set(k, { context, result, stations });
    }
    return baselines.get(k);
  };
}

const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const SEASON_W = { winter: 5 / 12, summer: 7 / 12 };
const DAY_W = { weekday: 5 / 7, weekend: 2 / 7 };

// Одна точка, один сценарий -> компактный итог для сайта.
function evaluatePoint(site, scenario) {
  const dist04 = dist04FromKnownTp(site.lat, site.lon, tp04);
  const ev = evaluateCandidate({
    candidateBase: { id: 'ZONE', lat: site.lat, lon: site.lon, operator: 'РСЗС', status: 'candidate' },
    cells,
    centers,
    params,
    getBaseline: getBaselineFor(scenario),
    dist04Meters: dist04,
    scenario,
    years: YEARS,
  });
  const e = ev.evaluated.find((x) => x.cfg.omega === EQUIPMENT);
  if (!e) return { cls: 'В', dist04 };
  // Разброс по режимам дня (выходной лета ... будни зимы) - полоса в паспорте.
  const comboTotals = (year) =>
    SEASONS.flatMap((season) => DAY_TYPES.map((dayType) => Object.values(e.sessionsByCombo[`${year}|${season}|${dayType}`]).reduce((x, y) => x + y, 0)));
  const segShare = {};
  for (const season of SEASONS)
    for (const dayType of DAY_TYPES)
      for (const [s, v] of Object.entries(e.sessionsByCombo[`2026|${season}|${dayType}`])) segShare[s] = (segShare[s] || 0) + SEASON_W[season] * DAY_W[dayType] * v;
  return {
    cls: e.cls,
    dist04,
    S: Object.fromEntries(YEARS.map((y) => [y, r2(yearAverage(e, y).sessions)])),
    G: Object.fromEntries(YEARS.map((y) => [y, r2(yearAverage(e, y).gain)])),
    Srange: Object.fromEntries(YEARS.map((y) => [y, [r2(Math.min(...comboTotals(y))), r2(Math.max(...comboTotals(y)))]])),
    seg2026: Object.fromEntries(Object.entries(segShare).map(([k, v]) => [k, r2(v)])),
    capex: e.scenarios ? [Math.round(e.scenarios.high.CAPEXrub), Math.round(e.scenarios.low.CAPEXrub)] : null,
    npv: e.scenarios ? [Math.round(e.scenarios.low.NPVrub), Math.round(e.scenarios.high.NPVrub)] : null,
    payback: e.scenarios ? [r2(e.scenarios.high.Tpb), r2(e.scenarios.low.Tpb)] : null,
    conn: e.connRange ? { cost: [e.connRange.costLow, e.connRange.costHigh], months: [e.connRange.monthsLow, e.connRange.monthsHigh] } : null,
    center: { id: ev.center.id, freeMW: r2(ev.centerFree / 1000) },
  };
}

const zones = buildZones().slice(0, LIMIT);
const poolSites = pool.slice(0, LIMIT);
console.log(`зон ${zones.length} (у ТП ${zones.filter((z) => z.atTp).length}), площадок пула ${poolSites.length}`);

const out = { zones: zones.map((z) => ({ key: z.key, district: z.district, lat: r2(z.site.lat * 1e4) / 1e4, lon: r2(z.site.lon * 1e4) / 1e4, atTp: z.atTp, by: {} })), sites: poolSites.map((p) => ({ id: p.id, by: {} })) };
for (const scenario of SCENARIOS) {
  zones.forEach((z, i) => {
    out.zones[i].by[scenario] = evaluatePoint(z.site, scenario);
    if (i % 50 === 0) console.log(`${scenario}: зона ${i}/${zones.length}, ${elapsed()}`);
  });
  poolSites.forEach((p, i) => {
    out.sites[i].by[scenario] = evaluatePoint(p, scenario);
    if (i % 50 === 0) console.log(`${scenario}: площадка ${i}/${poolSites.length}, ${elapsed()}`);
  });
}

writeFileSync(
  OUT_PATH,
  JSON.stringify({
    source: `scripts/compute-zones.js: станция ${EQUIPMENT} в каждой зоне (шестиугольник ${HEX_RADIUS_KM} км, точка - известная ТП 0.4 кВ в зоне или центр) и на каждой площадке data/pool.json; модуль 6 (equipment.js) при сети сценария, средний день года; опорные годы 2026, 2028, 2030, между ними - геометрическая интерполяция (9.3)`,
    date: new Date().toISOString().slice(0, 10),
    equipment: EQUIPMENT,
    ...out,
  })
);
console.log(`готово за ${elapsed()} → data/zones.json`);
