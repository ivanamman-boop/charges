// Модуль 8 (раздел 10): расстановка N новых станций двумя стратегиями из
// одного пула (data/pool.json) и сравнение их одной и той же моделью М1-М7.
//
//  - Традиционная (10.2): score = POI в 500 м + магистрали - загрузка
//    соседей в 1 км, по убыванию с шагом >= 1 км, всегда DC60-1. Энергетика -
//    поздним фильтром: площадка класса В выбывает (+ C_sunk потерянных
//    затрат), заменяющая запускается на T_B месяцев позже.
//  - По модели (10.3): жадно, на каждом шаге площадка и конфигурация с
//    лучшим NPV/CAPEX при сети, уже включающей выбранные раньше станции.
//    Быстрый отбор - одна локальная прикидка (DC60-2 и DC150-2, будни, лето,
//    2026) по всему пулу, точный модуль 6 - для лидеров отбора. Ленивый
//    пересчёт (CELF): точная оценка с прошлого шага - верхняя граница
//    (отток к новым соседям только уменьшает отдачу), кандидатов с границей
//    ниже лучшего точного результата шага не пересчитываем. Бюджет B -
//    суммарный CAPEX традиционной стратегии, включая C_sunk.
//  - Метрики (10.4): сеть после добавления N станций, базовый сценарий,
//    2028 год, U за год = среднее по сезонам и (5/7 будни + 2/7 выходные).
//
// Класс подключения: dist04 до ближайшей известной ТП 0.4 кВ (data/tp04.json,
// js/grid.js dist04FromKnownTp) - ближе 200 м = класс А, иначе консервативно Б.
//
// Упрощения относительно спецификации (честно, см. journal.md 23.09):
//  - ΔNPV^own берётся как NPV самой новой станции при сети с уже
//    выбранными: потери, которые она наносит ранее выбранным новым
//    станциям, отдельно не вычитаются (их учитывает следующий шаг, у
//    которого спрос уже поделён);
//  - считается офлайн в node, а не в Web Worker по кнопке - на сайте
//    показывается готовый data/portfolio.json.
//
// Запуск: npm run compute:portfolio  (-- --n=10; по умолчанию N=10)
// Идёт ~1 час: после каждого шага пишет промежуточный data/portfolio.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildNetworkContext, equilibrium, localEquilibrium, dailySessions } from '../js/equilibrium.js';
import { evaluateCandidate } from '../js/equipment.js';
import { haversineKm } from '../js/choice.js';
import { dist04FromKnownTp } from '../js/grid.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data');
const OUT_PATH = join(DATA, 'portfolio.json');
const read = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));

const N = Number(process.argv.find((a) => a.startsWith('--n='))?.slice(4) || 10);
const cells = read('cells.json').cells;
const baseStations = read('stations.json').stations;
const centersOrig = read('centers.json').centers;
const tp04 = read('tp04.json').points;
const pool = read('pool.json').pool.map((l) => ({ ...l, dist04_m: dist04FromKnownTp(l.lat, l.lon, tp04) }));
const params = read('params.json');
params.equilibrium = { ...params.equilibrium, convergence_threshold_hours: params.equilibrium.convergence_threshold_hours_precise };

const m8 = params.M8_portfolio;
const m7 = params.M6_M7_equipment_economics;
const MIN_BETWEEN_NEW_KM = m8.min_distance_between_new_km.value;
const TOP_N = m8.fast_screening_top_n.value;
const C_SUNK_RUB = m7.C_sunk_mln_rub.value * 1e6;
const T_B_MONTHS = m8.T_B_delay_months.value;
const R = m7.r_discount_rate.value;
const CATALOG = Object.fromEntries(m7.catalog.configs.map((c) => [c.omega, c]));
const SCREEN_CONFIGS = ['DC60-2', 'DC150-2'];
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 60000).toFixed(1)} мин`;

function asStation(site, cfg, tag) {
  return { id: `NEW-${tag}-${site.id}`, lat: site.lat, lon: site.lon, operator: 'новая', P_kW: cfg.P_cap_kW ?? cfg.P_kW, posts: cfg.posts, P_post_kW: cfg.P_post_kW, status: 'active', year_open: 2026 };
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

// Резерв ЦП уменьшается на мощность уже выбранных на нём станций (7.1,
// portfolioLoadKW) - иначе модель поставила бы несколько станций на одну
// подстанцию, каждый раз считая её резерв целым.
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
    load.set(best.id, (load.get(best.id) || 0) + p.P_kW);
  }
  return centersOrig.map((c) => (load.has(c.id) ? { ...c, reserve_MVA: c.reserve_MVA - load.get(c.id) / 1000 / cosPhi } : c));
}

function summarize(site, ev, e) {
  const sc = e?.scenarios;
  const s26 = e ? Object.values(e.sessionsByCombo['2026|summer|weekday']).reduce((a, b) => a + b, 0) : null;
  const s30 = e ? Object.values(e.sessionsByCombo['2030|summer|weekday']).reduce((a, b) => a + b, 0) : null;
  return {
    id: site.id,
    lat: site.lat,
    lon: site.lon,
    kind: site.kind,
    name: site.name,
    district: site.district,
    dist04_m: site.dist04_m ?? null,
    omega: e?.cfg.omega ?? null,
    P_kW: e?.cfg.P_cap_kW ?? null,
    posts: e?.cfg.posts ?? null,
    cls: e?.cls ?? null,
    S_2026: s26 && Number(s26.toFixed(2)),
    S_2030: s30 && Number(s30.toFixed(2)),
    minAcc: e && Number(e.minAcc.toFixed(3)),
    CAPEX_rub: sc ? Math.round(sc.low.CAPEXrub) : null,
    NPV_low_rub: sc ? Math.round(sc.low.NPVrub) : null,
    NPV_high_rub: sc ? Math.round(sc.high.NPVrub) : null,
    payback_years: sc?.low.Tpb ?? null, // economics.paybackMonths возвращает годы (t/12), несмотря на имя
    verdict: ev.verdict,
  };
}

// ---------- Традиционная стратегия (10.2) ----------
function traditionalStrategy() {
  console.log(`\n=== Традиционная стратегия (${elapsed()}) ===`);
  const poi = JSON.parse(readFileSync(join(__dirname, 'data-sources', 'osm-poi-moscow-compact.json'), 'utf8'));
  const poiPts = Array.isArray(poi) ? poi : poi.points || poi.poi || poi.objects;
  const base = makeBaselines([]);
  const { result, stations } = base(2026, 'summer', 'weekday');
  const S0 = dailySessions(result.qh.lambdaSrv, stations.length);

  const nearestCell = (lat, lon) => {
    let best = null;
    let bestD = Infinity;
    for (const c of cells) {
      const d = (c.lat - lat) ** 2 + ((c.lon - lon) * 0.56) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  };
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
  const ranked = raw
    .map((r) => ({ ...r, score: r.nPoi / mPoi + r.road / mRoad - r.sLoad / mLoad }))
    .sort((a, b) => b.score - a.score);

  const picks = [];
  const dropped = [];
  let sunk = 0;
  let pendingDelay = 0;
  for (const r of ranked) {
    if (picks.length >= N) break;
    if (picks.some((p) => haversineKm(p.lat, p.lon, r.l.lat, r.l.lon) < MIN_BETWEEN_NEW_KM)) continue;
    const getBaseline = makeBaselines(picks.map((p) => asStation(p, CATALOG['DC60-1'], 'T')));
    const ev = evaluateCandidate({ candidateBase: { id: 'CAND', lat: r.l.lat, lon: r.l.lon, operator: 'новая', status: 'active' }, cells, centers: centersWithLoad(picks.map((p) => ({ ...p, P_kW: 60 }))), params, getBaseline, dist04Meters: r.l.dist04_m });
    const e = ev.comparison.asAccepted;
    if (!e || e.cls === 'В') {
      // Класс В выяснился поздно: площадка выбывает, затраты на проект и
      // согласования потеряны, замена запускается на T_B позже.
      dropped.push({ id: r.l.id, lat: r.l.lat, lon: r.l.lon, kind: r.l.kind, district: r.l.district, reason: 'класс подключения В (нет резерва на ЦП)' });
      sunk += C_SUNK_RUB;
      pendingDelay += T_B_MONTHS;
      console.log(`  ${r.l.id}: класс В → выбывает (+C_sunk), ${elapsed()}`);
      continue;
    }
    const pick = { ...summarize(r.l, { verdict: 'традиционный выбор, DC60-1' }, e), score_trad: Number(r.score.toFixed(3)), delay_months: pendingDelay };
    // Задержка запуска: денежный поток сдвигается на delay месяцев -
    // NPV дисконтируется на этот срок (CAPEX платится при запуске).
    if (pendingDelay && pick.NPV_low_rub !== null) {
      const f = Math.pow(1 + R, -pendingDelay / 12);
      pick.NPV_low_rub = Math.round(pick.NPV_low_rub * f);
      pick.NPV_high_rub = Math.round(pick.NPV_high_rub * f);
    }
    pendingDelay = 0;
    picks.push({ ...pick, P_kW: 60, posts: 1, P_post_kW: 60 });
    console.log(`  #${picks.length} ${r.l.id} ${r.l.kind} ${r.l.district}: S26=${pick.S_2026} NPV=${(pick.NPV_low_rub / 1e6).toFixed(2)} млн, ${elapsed()}`);
  }
  const capexTotal = picks.reduce((a, p) => a + (p.CAPEX_rub || 0), 0) + sunk;
  return { picks, dropped, sunk_rub: sunk, budget_rub: capexTotal };
}

// ---------- Стратегия по модели (10.3) ----------
// tier 'low' - NPV при дорогой границе присоединения (надёжные площадки),
// 'high' - при дешёвой (площадки "ставить, если сеть подтвердит дешёвое
// присоединение" - тот же вердикт, что у паспорта при NPV_low < 0 < NPV_high).
function objective(e, tier = 'low') {
  return e?.scenarios ? e.scenarios[tier].NPVrub / e.scenarios[tier].CAPEXrub : -Infinity;
}

// Конфигурация с лучшей отдачей на рубль (10.3). Ограничение доступности
// модуля 6 (Acc >= alpha в самый тяжёлый режим, зима-будни-2030) на
// текущих данных не выполняет НИ ОДНА конфигурация ни на одной площадке:
// парк ЭМ к 2030 растёт в ~14 раз, а сеть станций в модели не растёт (нет
// данных о будущих станциях, см. README) - каждая новая станция в 2030
// захлёбывается. Поэтому: если есть конфигурации с Acc >= alpha - выбираем
// среди них, иначе среди всех с посчитанной экономикой, и помечаем
// accFlag, чтобы на сайте это было видно, а не спрятано.
function bestConfig(ev, tier, budgetLeft) {
  const alpha = params.M3_queue.alpha_accessibility.value;
  const withEco = ev.evaluated.filter((e) => e.scenarios && !e.cfg.costUnknown && e.scenarios[tier].CAPEXrub <= budgetLeft);
  const ok = withEco.filter((e) => e.minAcc >= alpha);
  const set = ok.length ? ok : withEco;
  if (!set.length) return { e: null, accFlag: false };
  const e = set.reduce((best, x) => (objective(x, tier) > objective(best, tier) ? x : best));
  return { e, accFlag: ok.length === 0 };
}

function modelStrategy(budget, onStep) {
  console.log(`\n=== Стратегия по модели, бюджет ${(budget / 1e6).toFixed(1)} млн (${elapsed()}) ===`);
  const picks = [];
  const bound = new Map(); // CELF: id -> точная оценка с прошлых шагов (верхняя граница)
  const minCapex = Math.min(...Object.values(CATALOG).map((c) => c.C_eq_mln_rub * 1e6));
  let spent = 0;
  let stoppedReason = null;
  let tier = 'low';

  for (let m = 1; m <= N; m++) {
    const extra = picks.map((p) => asStation(p, p, 'M'));
    const getBaseline = makeBaselines(extra);
    const { context, result, stations } = getBaseline(2026, 'summer', 'weekday');
    const centers = centersWithLoad(picks);

    // Быстрый отбор по всему пулу.
    const free = pool.filter((l) => !picks.some((p) => haversineKm(p.lat, p.lon, l.lat, l.lon) < MIN_BETWEEN_NEW_KM));
    const screened = free.map((l) => {
      let best = -Infinity;
      for (const omega of SCREEN_CONFIGS) {
        const cfg = CATALOG[omega];
        const cand = { id: 'CAND', lat: l.lat, lon: l.lon, operator: 'новая', P_kW: cfg.P_cap_kW, posts: cfg.posts, P_post_kW: cfg.P_post_kW, status: 'active', year_open: 2026 };
        const local = localEquilibrium({ cells, stations, candidate: cand, params, year: 2026, scenario: 'base', dayType: 'weekday', season: 'summer', fullContext: context, fullResult: result });
        const S = dailySessions(local.qh.lambdaSrv, local.localStations?.length ?? local.qh.lambdaSrv.length / 24)[local.candidateLocalIdx];
        // Отдача на рубль с учётом класса подключения: при известной ТП
        // ближе 200 м (класс А) присоединение в ~10 раз дешевле, чем по
        // классу Б - без этого отбор отсекал бы лучшие площадки.
        const g = params.M5_grid;
        const connRub = (l.dist04_m !== null && cfg.P_cap_kW <= 150 ? g.c_A_rub_per_kW.value : g.c_B_rub_per_kW.value) * cfg.P_cap_kW;
        best = Math.max(best, S / (cfg.C_eq_mln_rub * 1e6 + connRub));
      }
      return { l, screen: best * 1e6 };
    });
    screened.sort((a, b) => b.screen - a.screen);
    const shortlist = screened.slice(0, TOP_N);

    // Точный модуль 6 для лидеров, с ленивым пропуском.
    let bestE = null;
    let bestObj = -Infinity;
    let exact = 0;
    const order = [...shortlist].sort((a, b) => (bound.get(b.l.id) ?? Infinity) - (bound.get(a.l.id) ?? Infinity));
    for (const { l } of order) {
      if ((bound.get(l.id) ?? Infinity) <= bestObj) continue;
      const ev = evaluateCandidate({ candidateBase: { id: 'CAND', lat: l.lat, lon: l.lon, operator: 'новая', status: 'active' }, cells, centers, params, getBaseline, dist04Meters: l.dist04_m });
      exact++;
      const budgetLeft = budget - spent - (N - m) * minCapex;
      const { e, accFlag } = bestConfig(ev, tier, budgetLeft);
      const obj = e ? objective(e, tier) : -Infinity;
      bound.set(l.id, obj);
      if (obj > bestObj) {
        bestObj = obj;
        bestE = { l, ev, e, accFlag };
      }
    }
    if (!bestE) {
      // Самая дешёвая возможная станция: минимальное оборудование каталога +
      // присоединение по классу А + площадка и интеграция.
      const cheapest = Math.min(...Object.values(CATALOG).map((c) => c.C_eq_mln_rub * 1e6 + c.P_cap_kW * params.M5_grid.c_A_rub_per_kW.min)) + (m7.C_site_mln_rub.value + m7.C_int_mln_rub.value) * 1e6;
      stoppedReason =
        budget - spent - (N - m) * minCapex < cheapest
          ? `бюджет исчерпан: потрачено ${(spent / 1e6).toFixed(1)} из ${(budget / 1e6).toFixed(1)} млн ₽ (бюджет = CAPEX традиционного подхода, раздел 10.3)`
          : 'у всех лидеров отбора нет допустимой конфигурации в пределах бюджета';
      console.log(`  шаг ${m}: ${stoppedReason}`);
      break;
    }
    if (bestObj < 0 && tier === 'low') {
      // Надёжные площадки кончились - дальше только те, что окупаются при
      // дешёвом присоединении (класс не доказан данными, см. tp04.json).
      console.log(`  шаг ${m}: при дорогом присоединении больше ничего не окупается → переходим к площадкам, окупающимся при дешёвом`);
      tier = 'high';
      bound.clear();
      m--;
      continue;
    }
    if (bestObj < 0) {
      stoppedReason = `на шаге ${m} все оставшиеся кандидаты дают NPV < 0 даже при дешёвом присоединении - модель советует поставить меньше станций`;
      console.log(`  ${stoppedReason}`);
      break;
    }
    const pick = summarize(bestE.l, bestE.ev, bestE.e);
    pick.P_post_kW = bestE.e.cfg.P_post_kW;
    pick.acc_2030_below_target = bestE.accFlag;
    pick.tier = tier === 'low' ? 'ставить' : 'если сеть подтвердит дешёвое присоединение';
    pick.verdict = tier === 'low' ? `Ставить ${bestE.e.cfg.omega}` : `Запросить у сети точную стоимость присоединения (${bestE.e.cfg.omega})`;
    pick.npv_per_rub = Number(bestObj.toFixed(3));
    picks.push(pick);
    spent += bestE.e.scenarios[tier].CAPEXrub;
    console.log(`  #${m} ${pick.id} ${pick.kind} ${pick.district} ${pick.omega} (класс ${pick.cls}): S26=${pick.S_2026} NPV=${(pick.NPV_low_rub / 1e6).toFixed(2)} млн, NPV/CAPEX=${pick.npv_per_rub}; точных оценок ${exact}, ${elapsed()}`);
    onStep({ picks, stoppedReason, shortlist: screened.slice(0, 30).map((s) => ({ id: s.l.id, screen: Number(s.screen.toFixed(3)) })) });
  }
  return { picks, stoppedReason, spent_rub: spent };
}

// ---------- Метрики (10.4) ----------
function metrics(picks, tag) {
  const extra = picks.map((p) => asStation(p, p, tag));
  const acc = { U: new Float64Array(baseStations.length + extra.length), S: 0 };
  const W = { summer: 0.5, winter: 0.5, weekday: 5 / 7, weekend: 2 / 7 };
  let stations = null;
  for (const season of ['summer', 'winter'])
    for (const dayType of ['weekday', 'weekend']) {
      stations = [...baseStations.filter((s) => s.year_open <= 2028), ...extra];
      const context = buildNetworkContext({ cells, stations, params });
      const res = equilibrium({ cells, stations, params, year: 2028, scenario: 'base', dayType, season, context });
      const w = W[season] * W[dayType];
      for (let j = 0; j < stations.length; j++) {
        let u = 0;
        for (let h = 0; h < 24; h++) u += res.qh.U[j * 24 + h];
        acc.U[j] += (w * u) / 24;
      }
      acc.S += w * dailySessions(res.qh.lambdaSrv, stations.length).reduce((a, b) => a + b, 0);
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
  const allIdx = stations.map((_, j) => j);
  return {
    n: picks.length,
    U_new_mean: Number(wMean(newIdx).toFixed(4)),
    U_network_mean: Number(wMean(allIdx).toFixed(4)),
    share_new_U_below_20: picks.length ? Number((newIdx.filter((j) => acc.U[j] < 0.2).length / picks.length).toFixed(3)) : null,
    sessions_per_day_network: Math.round(acc.S),
    NPV_low_total_rub: picks.reduce((a, p) => a + (p.NPV_low_rub || 0), 0),
    NPV_high_total_rub: picks.reduce((a, p) => a + (p.NPV_high_rub || 0), 0),
    CAPEX_total_rub: picks.reduce((a, p) => a + (p.CAPEX_rub || 0), 0),
  };
}

function save(out) {
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));
}

const out = {
  source: `Модуль 8 (раздел 10), scripts/compute-portfolio.js: N=${N}, пул ${pool.length} площадок (data/pool.json), базовый сценарий`,
  date: new Date().toISOString().slice(0, 10),
  status: 'running',
  N,
};
// --reuse-traditional: традиционная стратегия не зависит от модельной -
// берём её из прошлого data/portfolio.json, не пересчитывая (~10 мин).
if (process.argv.includes('--reuse-traditional')) {
  out.traditional = read('portfolio.json').traditional;
  console.log(`традиционная стратегия взята из прошлого прогона: ${out.traditional.picks.length} площадок`);
} else {
  out.traditional = traditionalStrategy();
}
save(out);
out.model = modelStrategy(out.traditional.budget_rub, (partial) => {
  out.model = partial;
  save(out);
});
console.log(`\n=== Метрики 2028 (${elapsed()}) ===`);
out.metrics = { baseline: metrics([], 'X'), traditional: metrics(out.traditional.picks, 'T'), model: metrics(out.model.picks, 'M') };
out.metrics.traditional.CAPEX_total_rub += out.traditional.sunk_rub;
console.log(JSON.stringify(out.metrics, null, 1));
out.status = 'done';
save(out);
console.log(`готово за ${elapsed()} → data/portfolio.json`);
