// Модуль 8 (раздел 10): где ставить N новых станций - две стратегии из одного
// пула (data/pool.json), обе считаются одной и той же моделью спроса, выбора
// станции, очереди и соседей.
//
// Решение команды 24.09: сайт - "стерильная" модель клиентов, без экономики
// (её команда считает отдельно по выбранной точке). Поэтому:
//  - оборудование одинаковое у обеих стратегий - DC150-2 (стандарт плана
//    «Энергии Москвы»: 150 кВт), сравнивается только МЕСТО;
//  - цель - новые для сети клиенты на 1 млн ₽ вложений: G = −(ΔΛ_out +
//    ΔΛ_lost) (6.3) - сессии, которые сеть с новой станцией обслуживает
//    сверх сети без неё, без переманенных у соседей; средний день года (5/12
//    зима + 7/12 лето, 5/7 будни + 2/7 выходные), среднее за 2026 и 2030 (оба
//    года точно; интерполяции на 2028 нет - дефицит сети по годам не
//    монотонен, см. журнал 24.09). Вложения = оборудование + присоединение +
//    площадка (дорогая граница класса) - без тарифов и цены электроэнергии.
//    Оборудование одинаковое, поэтому по сути это цена присоединения: класс А
//    (ТП 0.4 кВ ближе 200 м, ~5-10 тыс. ₽/кВт) против Б (~50-80 тыс. ₽/кВт) -
//    место рядом с сетью Россетей обгоняет такое же место вдали от неё
//    (решение команды 24.09: стоимость подключения - фактор выбора);
//  - ограничения сети остаются (задание: модель "без учёта ограничений
//    энергосистемы" не подходит): класс В (нет резерва на центре питания)
//    исключён, резерв ЦП уменьшается на уже выбранные станции, класс А/Б по
//    известным ТП 0.4 кВ (tp04.json) показывается у каждой площадки.
//
//  - Традиционная (10.2): score = POI в 500 м + магистрали − загрузка
//    соседей в 1 км, по убыванию с шагом >= 1 км. Энергетика - поздним
//    фильтром: площадка класса В выбывает и заменяется следующей.
//  - По модели (10.3): жадно, на каждом шаге площадка с наибольшим G при
//    сети, уже включающей выбранные раньше станции. Быстрый отбор - одна
//    локальная прикидка (будни, лето, 2026) по всему пулу, точная оценка (8
//    режимов) - для лидеров. Ленивый пересчёт (CELF): точная оценка с
//    прошлого шага - верхняя граница, кандидатов ниже лучшего точного
//    результата шага не пересчитываем.
//  - Метрики: сеть после добавления станций, 2026 / 2028 / 2030: прирост
//    обслуженного спроса, загрузка новых, доступность (доля обслуженного
//    спроса, отказы из-за очереди, ожидание в пиковый час).
//
// Считается офлайн в node, сайт показывает готовый data/portfolio.json.
// Запуск: npm run compute:portfolio  (-- --n=10)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildNetworkContext, equilibrium, localEquilibrium, dailySessions, totalArrivalPerStationHour } from '../js/equilibrium.js';
import { evaluateCandidate, yearAverage } from '../js/equipment.js';
import { haversineKm } from '../js/choice.js';
import { dist04FromKnownTp } from '../js/grid.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data');
const OUT_PATH = join(DATA, 'portfolio.json');
const read = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));

const N = Number(process.argv.find((a) => a.startsWith('--n='))?.slice(4) || 10);
const EQUIPMENT = 'DC150-2';
const cells = read('cells.json').cells;
const baseStations = read('stations.json').stations;
const centersOrig = read('centers.json').centers;
const tp04 = read('tp04.json').points;
const pool = read('pool.json').pool.map((l) => ({ ...l, dist04_m: dist04FromKnownTp(l.lat, l.lon, tp04) }));
const params = read('params.json');
params.equilibrium = { ...params.equilibrium, convergence_threshold_hours: params.equilibrium.convergence_threshold_hours_precise };
// Каталог только из выбранного оборудования - evaluateCandidate оценит один вариант.
const paramsOneCfg = JSON.parse(JSON.stringify(params));
paramsOneCfg.M6_M7_equipment_economics.catalog.configs = params.M6_M7_equipment_economics.catalog.configs.filter((c) => c.omega === EQUIPMENT);
const CFG = paramsOneCfg.M6_M7_equipment_economics.catalog.configs[0];

const m8 = params.M8_portfolio;
const MIN_BETWEEN_NEW_KM = m8.min_distance_between_new_km.value;
const TOP_N = m8.fast_screening_top_n.value;
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 60000).toFixed(1)} мин`;

function asStation(site, tag) {
  return { id: `NEW-${tag}-${site.id}`, lat: site.lat, lon: site.lon, operator: 'новая', P_kW: CFG.P_cap_kW, posts: CFG.posts, P_post_kW: CFG.P_post_kW, status: 'active', year_open: 2026 };
}

// Опорные равновесия (8 режимов) для сети "действующие + выбранные новые".
function makeBaselines(extra) {
  const cache = new Map();
  return function getBaseline(year, season, dayType) {
    const key = `${year}|${season}|${dayType}`;
    if (cache.has(key)) return cache.get(key);
    const stations = [...baseStations.filter((s) => s.year_open <= year), ...extra];
    const context = buildNetworkContext({ cells, stations, params });
    const result = equilibrium({ cells, stations, params, year, scenario: 'base', dayType, season, context });
    const entry = { context, result, stations };
    cache.set(key, entry);
    return entry;
  };
}

// Резерв ЦП уменьшается на мощность уже выбранных на нём станций (7.1) -
// иначе две новые станции заняли бы один резерв дважды.
function centersWithLoad(picks) {
  const cosPhi = params.M5_grid.cos_phi.value;
  const load = new Map();
  for (const p of picks) {
    let best = null;
    let bestD = Infinity;
    for (const c of centersOrig) {
      const d = haversineKm(p.lat, p.lon, c.lat, c.lon);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    load.set(best.id, (load.get(best.id) || 0) + CFG.P_cap_kW);
  }
  return centersOrig.map((c) => (load.has(c.id) ? { ...c, reserve_MVA: c.reserve_MVA - load.get(c.id) / 1000 / cosPhi } : c));
}

// Точная оценка площадки: 8 локальных равновесий (2026/2030 × зима/лето ×
// будни/выходные) для EQUIPMENT; null - подключить нельзя (класс В).
function evaluateSite(l, getBaseline, centers) {
  const ev = evaluateCandidate({ candidateBase: { id: 'CAND', lat: l.lat, lon: l.lon, operator: 'новая', status: 'active' }, cells, centers, params: paramsOneCfg, getBaseline, dist04Meters: l.dist04_m });
  const e = ev.evaluated[0];
  if (!e || e.cls === 'В') return null;
  const y26 = yearAverage(e, 2026);
  const y30 = yearAverage(e, 2030);
  const capexRub = e.scenarios?.low.CAPEXrub;
  if (!capexRub) return null;
  return { e, y26, y30, capexRub, objective: (y26.gain + y30.gain) / 2 / (capexRub / 1e6) };
}

function summarize(l, r) {
  return {
    id: l.id,
    lat: l.lat,
    lon: l.lon,
    kind: l.kind,
    name: l.name,
    district: l.district,
    dist04_m: l.dist04_m ?? null,
    omega: EQUIPMENT,
    P_kW: CFG.P_cap_kW,
    posts: CFG.posts,
    P_post_kW: CFG.P_post_kW,
    cls: r.e.cls,
    sessions_2026: Number(r.y26.sessions.toFixed(2)),
    sessions_2030: Number(r.y30.sessions.toFixed(2)),
    new_demand_2026: Number(r.y26.gain.toFixed(2)),
    new_demand_2030: Number(r.y30.gain.toFixed(2)),
    acc_day_2026: Number(r.e.accDayByYear[2026].toFixed(3)),
    acc_day_2030: Number(r.e.accDayByYear[2030].toFixed(3)),
    conn_cost_low_rub: Math.round(r.e.connRange.costLow),
    conn_cost_high_rub: Math.round(r.e.connRange.costHigh),
    conn_months_low: r.e.connRange.monthsLow,
    conn_months_high: r.e.connRange.monthsHigh,
    capex_rub: Math.round(r.capexRub),
    new_per_mln: Number(r.objective.toFixed(3)),
  };
}

// ---------- Традиционная стратегия (10.2) ----------
function traditionalStrategy() {
  console.log(`\n=== Традиционная стратегия (${elapsed()}) ===`);
  const poi = JSON.parse(readFileSync(join(__dirname, 'data-sources', 'osm-poi-moscow-compact.json'), 'utf8'));
  const poiPts = Array.isArray(poi) ? poi : poi.points || poi.poi || poi.objects;
  const { result, stations } = makeBaselines([])(2026, 'summer', 'weekday');
  const S0 = dailySessions(result.qh.lambdaSrv, stations.length);
  const dist2 = (c, lat, lon) => (c.lat - lat) ** 2 + ((c.lon - lon) * 0.56) ** 2;
  const nearestCell = (lat, lon) => cells.reduce((best, c) => (dist2(c, lat, lon) < dist2(best, lat, lon) ? c : best));
  const raw = pool.map((l) => {
    let nPoi = 0;
    for (const [la, lo] of poiPts) if (Math.abs(la - l.lat) < 0.0055 && Math.abs(lo - l.lon) < 0.009 && haversineKm(l.lat, l.lon, la, lo) <= 0.5) nPoi++;
    let sLoad = 0;
    stations.forEach((s, j) => {
      if (haversineKm(l.lat, l.lon, s.lat, s.lon) < 1) sLoad += S0[j];
    });
    return { l, nPoi, road: nearestCell(l.lat, l.lon).layers.road, sLoad };
  });
  const max = (k) => Math.max(...raw.map((r) => r[k])) || 1;
  const [mPoi, mRoad, mLoad] = [max('nPoi'), max('road'), max('sLoad')];
  const ranked = raw.map((r) => ({ ...r, score: r.nPoi / mPoi + r.road / mRoad - r.sLoad / mLoad })).sort((a, b) => b.score - a.score);

  const picks = [];
  const dropped = [];
  for (const r of ranked) {
    if (picks.length >= N) break;
    if (picks.some((p) => haversineKm(p.lat, p.lon, r.l.lat, r.l.lon) < MIN_BETWEEN_NEW_KM)) continue;
    const res = evaluateSite(r.l, makeBaselines(picks.map((p) => asStation(p, 'T'))), centersWithLoad(picks));
    if (!res) {
      dropped.push({ id: r.l.id, lat: r.l.lat, lon: r.l.lon, kind: r.l.kind, district: r.l.district, reason: 'класс подключения В (нет резерва на центре питания)' });
      console.log(`  ${r.l.id}: класс В → выбывает, ${elapsed()}`);
      continue;
    }
    const pick = { ...summarize(r.l, res), score_trad: Number(r.score.toFixed(3)) };
    picks.push(pick);
    console.log(`  #${picks.length} ${r.l.id} ${r.l.kind} ${r.l.district}: новых ${pick.new_demand_2026} → ${pick.new_demand_2030}, всего ${pick.sessions_2026} → ${pick.sessions_2030} сес/сут, ${elapsed()}`);
  }
  return { picks, dropped };
}

// ---------- Стратегия по модели (10.3) ----------
function modelStrategy(onStep) {
  console.log(`\n=== Стратегия по модели (${elapsed()}) ===`);
  const picks = [];
  const bound = new Map(); // CELF: id -> точная оценка с прошлых шагов (верхняя граница)
  let stoppedReason = null;

  for (let m = 1; m <= N; m++) {
    const getBaseline = makeBaselines(picks.map((p) => asStation(p, 'M')));
    const { context, result, stations } = getBaseline(2026, 'summer', 'weekday');
    const centers = centersWithLoad(picks);

    // Быстрый отбор: новые клиенты (будни, лето, 2026) на рубль оборудования +
    // присоединения по классу (А при известной ТП ближе 200 м, иначе Б).
    const free = pool.filter((l) => !picks.some((p) => haversineKm(p.lat, p.lon, l.lat, l.lon) < MIN_BETWEEN_NEW_KM));
    const g = params.M5_grid;
    const screened = free
      .map((l) => {
        const cand = { ...asStation(l, 'CAND'), id: 'CAND' };
        const local = localEquilibrium({ cells, stations, candidate: cand, params, year: 2026, scenario: 'base', dayType: 'weekday', season: 'summer', fullContext: context, fullResult: result });
        const connRub = (l.dist04_m !== null ? g.c_A_rub_per_kW.max : g.c_B_rub_per_kW.max) * CFG.P_cap_kW;
        return { l, screen: -(local.deltaLambdaOut + local.deltaLambdaLost) / (CFG.C_eq_mln_rub * 1e6 + connRub) };
      })
      .sort((a, b) => b.screen - a.screen);
    const shortlist = screened.slice(0, TOP_N);

    let best = null;
    let exact = 0;
    const order = [...shortlist].sort((a, b) => (bound.get(b.l.id) ?? Infinity) - (bound.get(a.l.id) ?? Infinity));
    for (const { l } of order) {
      if ((bound.get(l.id) ?? Infinity) <= (best?.objective ?? -Infinity)) continue;
      const res = evaluateSite(l, getBaseline, centers);
      exact++;
      bound.set(l.id, res ? res.objective : -Infinity);
      if (res && res.objective > (best?.objective ?? -Infinity)) best = { l, ...res };
    }
    if (!best || best.objective <= 0) {
      stoppedReason = best ? `на шаге ${m} новые станции уже не добавляют сети клиентов - только переманивают у соседей` : `на шаге ${m} у лидеров отбора нет резерва мощности на центрах питания (класс В)`;
      console.log(`  ${stoppedReason}`);
      break;
    }
    const pick = summarize(best.l, best);
    picks.push(pick);
    console.log(`  #${m} ${pick.id} ${pick.kind} ${pick.district} (класс ${pick.cls}): новых ${pick.new_demand_2026} → ${pick.new_demand_2030}, всего ${pick.sessions_2026} → ${pick.sessions_2030} сес/сут, ${pick.new_per_mln} на млн ₽; точных оценок ${exact}, ${elapsed()}`);
    onStep({ picks, stoppedReason });
  }
  return { picks, stoppedReason };
}

// ---------- Метрики: загрузка и доступность по годам ----------
const SEASON_W = { winter: 5 / 12, summer: 7 / 12 };
const DAY_W = { weekday: 5 / 7, weekend: 2 / 7 };
function metrics(picks, tag, year) {
  const extra = picks.map((p) => asStation(p, tag));
  const acc = { U: new Float64Array(baseStations.length + extra.length), S: 0, demand: 0, arrivals: 0, lost: 0, peakWait: 0, peakArr: 0 };
  let stations = null;
  for (const season of ['summer', 'winter'])
    for (const dayType of ['weekday', 'weekend']) {
      stations = [...baseStations.filter((s) => s.year_open <= year), ...extra];
      const context = buildNetworkContext({ cells, stations, params });
      const res = equilibrium({ cells, stations, params, year, scenario: 'base', dayType, season, context });
      const w = SEASON_W[season] * DAY_W[dayType];
      const n = stations.length;
      const arrivals = totalArrivalPerStationHour(res.lam, n);
      const byHour = new Float64Array(24);
      for (let j = 0; j < n; j++) {
        let u = 0;
        for (let h = 0; h < 24; h++) {
          const k = j * 24 + h;
          u += res.qh.U[k];
          byHour[h] += arrivals[k];
          acc.arrivals += w * arrivals[k];
          acc.lost += w * (arrivals[k] - res.qh.lambdaSrv[k]);
        }
        acc.U[j] += (w * u) / 24;
      }
      const peak = byHour.indexOf(Math.max(...byHour));
      for (let j = 0; j < n; j++) {
        acc.peakWait += w * arrivals[j * 24 + peak] * res.qh.W[j * 24 + peak];
        acc.peakArr += w * arrivals[j * 24 + peak];
      }
      for (const s of Object.keys(res.demand)) for (const v of res.demand[s]) acc.demand += w * v;
      acc.S += w * dailySessions(res.qh.lambdaSrv, n).reduce((a, b) => a + b, 0);
    }
  const nBase = stations.length - extra.length;
  const wMean = (idx) => {
    let num = 0;
    let den = 0;
    for (const j of idx) {
      num += acc.U[j] * stations[j].posts;
      den += stations[j].posts;
    }
    return den ? num / den : 0;
  };
  const newIdx = extra.map((_, k) => nBase + k);
  return {
    n: picks.length,
    sessions_per_day_network: Math.round(acc.S),
    U_new_mean: Number(wMean(newIdx).toFixed(4)),
    U_network_mean: Number(wMean(stations.map((_, j) => j)).toFixed(4)),
    share_new_U_below_20: picks.length ? Number((newIdx.filter((j) => acc.U[j] < 0.2).length / picks.length).toFixed(3)) : null,
    served_share_of_demand: Number((acc.S / acc.demand).toFixed(4)),
    queue_loss_share: Number((acc.lost / acc.arrivals).toFixed(4)),
    wait_min_peak: Number(((acc.peakWait / acc.peakArr) * 60).toFixed(2)),
  };
}

const save = (out) => writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));
const out = {
  source: `Модуль 8, scripts/compute-portfolio.js: N=${N}, оборудование ${EQUIPMENT} у обеих стратегий, пул ${pool.length} площадок внутри МКАД, цель - новые для сети клиенты на 1 млн ₽ вложений (оборудование + подключение), без тарифов`,
  date: new Date().toISOString().slice(0, 10),
  status: 'running',
  N,
  equipment: EQUIPMENT,
};
out.traditional = traditionalStrategy();
save(out);
out.model = modelStrategy((partial) => {
  out.model = partial;
  save(out);
});
out.metrics_by_year = {};
for (const year of [2026, 2028, 2030]) {
  console.log(`\n=== Метрики ${year} (${elapsed()}) ===`);
  out.metrics_by_year[year] = { baseline: metrics([], 'X', year), traditional: metrics(out.traditional.picks, 'T', year), model: metrics(out.model.picks, 'M', year) };
  console.log(JSON.stringify(out.metrics_by_year[year]));
}
out.status = 'done';
save(out);
console.log(`готово за ${elapsed()} → data/portfolio.json`);
