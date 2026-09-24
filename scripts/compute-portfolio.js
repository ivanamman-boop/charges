// Модуль 8 (раздел 10): расстановка N новых станций двумя стратегиями из
// одного пула (data/pool.json) и сравнение их одной и той же моделью М1-М7.
//
//  - Традиционная (10.2): score = POI в 500 м + магистрали - загрузка
//    соседей в 1 км, по убыванию с шагом >= 1 км, всегда DC60-1. Энергетика -
//    поздним фильтром: площадка класса В выбывает (+ C_sunk потерянных
//    затрат), заменяющая запускается на T_B месяцев позже.
//  - По модели (10.3): жадно, на каждом шаге площадка и конфигурация с
//    наибольшим НОВЫМ для сети спросом на рубль CAPEX (не NPV - см. ниже у
//    objective) при сети, уже включающей выбранные раньше станции.
//    Быстрый отбор - одна локальная прикидка (DC60-2 и DC150-2, будни, лето,
//    2026) по всему пулу, точный модуль 6 - для лидеров отбора. Ленивый
//    пересчёт (CELF): точная оценка с прошлого шага - верхняя граница
//    (отток к новым соседям только уменьшает отдачу), кандидатов с границей
//    ниже лучшего точного результата шага не пересчитываем. Бюджет B -
//    суммарный CAPEX традиционной стратегии, включая C_sunk.
//  - Метрики (10.4): сеть после добавления N станций, базовый сценарий,
//    2028 год, средний день года; + доступность (доля обслуженного спроса,
//    отказы, ожидание) - третья часть критерия успеха задания.
//  - Экономика - дополнительно: NPV в диапазоне цены электроэнергии.
//
// Класс подключения: dist04 до ближайшей известной ТП 0.4 кВ (data/tp04.json,
// js/grid.js dist04FromKnownTp) - ближе 200 м = класс А, иначе консервативно Б.
//
// Упрощения относительно спецификации (честно, см. journal.md 23.09):
//  - цель - новый спрос на рубль, а не ΔNPV^own из 10.3 (задание ставит
//    экономику дополнительным плюсом, а NPV зависит от цены электроэнергии
//    без источника); переманивание у ранее выбранных новых станций
//    учитывается - они уже в сети следующего шага;
//  - считается офлайн в node, а не в Web Worker по кнопке - на сайте
//    показывается готовый data/portfolio.json.
//
// Запуск: npm run compute:portfolio  (-- --n=10; по умолчанию N=10)
// Идёт ~1 час: после каждого шага пишет промежуточный data/portfolio.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildNetworkContext, equilibrium, localEquilibrium, dailySessions, totalArrivalPerStationHour } from '../js/equilibrium.js';
import { interpolateSessions, opexFixYearRub, monthlyCashFlow, marginPerSession, npv } from '../js/economics.js';
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
    const pick = {
      ...summarize(r.l, { verdict: 'традиционный выбор, DC60-1' }, e),
      ...economicsRange(e),
      new_demand_2026: Number(newDemand(e, 2026).toFixed(2)),
      new_demand_2030: Number(newDemand(e, 2030).toFixed(2)),
      new_demand_per_mln: Number(objective(e).toFixed(3)),
      score_trad: Number(r.score.toFixed(3)),
      delay_months: pendingDelay,
    };
    // Задержка запуска: денежный поток сдвигается на delay месяцев -
    // NPV дисконтируется на этот срок (CAPEX платится при запуске).
    if (pendingDelay && pick.NPV_low_rub !== null) {
      const f = Math.pow(1 + R, -pendingDelay / 12);
      pick.NPV_low_rub = Math.round(pick.NPV_low_rub * f);
      for (const k of ['NPV_high_rub', 'NPV_pel_min_rub', 'NPV_pel_max_rub']) pick[k] = Math.round(pick[k] * f);
    }
    pendingDelay = 0;
    picks.push({ ...pick, P_kW: 60, posts: 1, P_post_kW: 60 });
    console.log(`  #${picks.length} ${r.l.id} ${r.l.kind} ${r.l.district}: новый спрос ${pick.new_demand_2026} → ${pick.new_demand_2030} сес/сут, S26=${pick.S_2026}, NPV=${(pick.NPV_low_rub / 1e6).toFixed(2)} млн, ${elapsed()}`);
  }
  const capexTotal = picks.reduce((a, p) => a + (p.CAPEX_rub || 0), 0) + sunk;
  return { picks, dropped, sunk_rub: sunk, budget_rub: capexTotal };
}

// ---------- Стратегия по модели (10.3) ----------
// Цель - НЕ NPV, а новый для сети спрос на рубль вложений (решение 24.09).
// Критерий успеха из задания (p_3_ru.pdf): решение "повышает загрузку сети,
// снижает инфраструктурные издержки и улучшает доступность зарядки";
// экономическая модель - "дополнительное преимущество". NPV к тому же
// держится на самом ненадёжном числе модели (цена электроэнергии 10 ₽ без
// источника), а новый спрос - на ядре (спрос × выбор × очередь × соседи).
//
// Новый спрос G = −(ΔΛ_out + ΔΛ_lost): сессии/сутки, которые сеть с
// кандидатом обслуживает сверх сети без него (люди, что раньше уезжали без
// зарядки или уходили из-за очереди), без переманенных у соседей. Средний
// день года: сезоны 5/12 зима + 7/12 лето, 5/7 будни + 2/7 выходные.
// Цель - среднее G за 2026 и 2030 (оба года посчитаны точно). Интерполяции
// на 2028 нет намеренно: дефицит сети по годам НЕ монотонен - к 2028 плановые
// станции города почти закрывают его (97.7% спроса обслужено против 91% в
// 2026), к 2030 спрос уходит в отрыв снова; интерполяция это прятала и
// завышала вклад площадок в 2028 в ~6 раз (журнал 24.09).
const SEASON_W = { winter: 5 / 12, summer: 7 / 12 };
const DAY_W = { weekday: 5 / 7, weekend: 2 / 7 };
function newDemand(e, year) {
  let g = 0;
  for (const season of ['winter', 'summer'])
    for (const dayType of ['weekday', 'weekend']) g += SEASON_W[season] * DAY_W[dayType] * e.netGainByCombo[`${year}|${season}|${dayType}`];
  return g;
}
// сессий/сутки нового спроса (среднее 2026 и 2030) на 1 млн ₽ CAPEX (дорогое присоединение)
function objective(e) {
  return e?.scenarios ? (newDemand(e, 2026) + newDemand(e, 2030)) / 2 / (e.scenarios.low.CAPEXrub / 1e6) : -Infinity;
}

// Конфигурация с лучшим объективом в пределах бюджета. Присоединение должно
// быть возможно (класс В - нет экономики, исключён: ограничение энергосистемы
// из задания). Требование доступности модуля 6 (Acc >= alpha в зиму-будни-
// 2030) при парке ×14 и сети ×3 к 2030 не выполняет ни одна конфигурация -
// тогда выбираем среди всех и помечаем accFlag (видно на сайте).
function bestConfig(ev, budgetLeft) {
  const alpha = params.M3_queue.alpha_accessibility.value;
  const withEco = ev.evaluated.filter((e) => e.scenarios && !e.cfg.costUnknown && e.scenarios.low.CAPEXrub <= budgetLeft);
  const ok = withEco.filter((e) => e.minAcc >= alpha);
  const set = ok.length ? ok : withEco;
  if (!set.length) return { e: null, accFlag: false };
  const e = set.reduce((best, x) => (objective(x) > objective(best) ? x : best));
  return { e, accFlag: ok.length === 0 };
}

// Экономика - дополнительно (задание): NPV в диапазоне цены электроэнергии
// (p_el - параметр без источника, min..max из params) при дорогом
// присоединении. Денежный поток - тот же, что в модуле 6 (equipment.js).
function npvAtElectricityPrice(e, pEl) {
  const p2 = JSON.parse(JSON.stringify(params));
  p2.M6_M7_equipment_economics.p_el_rub_per_kWh.value = pEl;
  const getSessions = (year, season, dayType, segment) =>
    interpolateSessions({ 2026: e.sessionsByCombo[`2026|${season}|${dayType}`][segment], 2030: e.sessionsByCombo[`2030|${season}|${dayType}`][segment] }, year);
  const OPEX = opexFixYearRub({ posts: e.cfg.posts, CeqRub: e.cfg.C_eq_rub, params: p2 });
  const CF = monthlyCashFlow({ getSessions, marginBySegmentSeason: (s) => marginPerSession({ segment: s, season: 'summer', params: p2 }), TconnMonths: e.connRange.monthsHigh, OPEXfixYearRub: OPEX, startYear: 2026, H: m7.H_years.value, r: R });
  return npv(CF, e.scenarios.low.CAPEXrub, R);
}

function economicsRange(e) {
  const pe = m7.p_el_rub_per_kWh;
  const cheap = npvAtElectricityPrice(e, pe.min);
  const dear = npvAtElectricityPrice(e, pe.max);
  const base = e.scenarios.low.NPVrub;
  return {
    NPV_pel_min_rub: Math.round(cheap),
    NPV_pel_max_rub: Math.round(dear),
    p_el_min: pe.min,
    p_el_max: pe.max,
    econ_verdict: dear > 0 ? 'окупается при любой цене электроэнергии' : base > 0 ? `окупается при ${pe.value} ₽/кВт·ч` : cheap > 0 ? `окупается только при дешёвой электроэнергии (${pe.min} ₽)` : 'не окупается при нынешних тарифах',
  };
}

function modelStrategy(budget, onStep) {
  console.log(`\n=== Стратегия по модели, бюджет ${(budget / 1e6).toFixed(1)} млн (${elapsed()}) ===`);
  const picks = [];
  const bound = new Map(); // CELF: id -> точная оценка с прошлых шагов (верхняя граница)
  const minCapex = Math.min(...Object.values(CATALOG).map((c) => c.C_eq_mln_rub * 1e6));
  let spent = 0;
  let stoppedReason = null;

  for (let m = 1; m <= N; m++) {
    const extra = picks.map((p) => asStation(p, p, 'M'));
    const getBaseline = makeBaselines(extra);
    const { context, result, stations } = getBaseline(2026, 'summer', 'weekday');
    const centers = centersWithLoad(picks);

    // Быстрый отбор: новый спрос (будни, лето, 2026) на рубль оборудования +
    // присоединения по классу (класс А ~в 10 раз дешевле Б).
    const free = pool.filter((l) => !picks.some((p) => haversineKm(p.lat, p.lon, l.lat, l.lon) < MIN_BETWEEN_NEW_KM));
    const g = params.M5_grid;
    const screened = free.map((l) => {
      let best = -Infinity;
      for (const omega of SCREEN_CONFIGS) {
        const cfg = CATALOG[omega];
        const cand = { id: 'CAND', lat: l.lat, lon: l.lon, operator: 'новая', P_kW: cfg.P_cap_kW, posts: cfg.posts, P_post_kW: cfg.P_post_kW, status: 'active', year_open: 2026 };
        const local = localEquilibrium({ cells, stations, candidate: cand, params, year: 2026, scenario: 'base', dayType: 'weekday', season: 'summer', fullContext: context, fullResult: result });
        const gain = -(local.deltaLambdaOut + local.deltaLambdaLost);
        const connRub = (l.dist04_m !== null && cfg.P_cap_kW <= 150 ? g.c_A_rub_per_kW.value : g.c_B_rub_per_kW.value) * cfg.P_cap_kW;
        best = Math.max(best, gain / (cfg.C_eq_mln_rub * 1e6 + connRub));
      }
      return { l, screen: best * 1e6 };
    });
    screened.sort((a, b) => b.screen - a.screen);
    const shortlist = screened.slice(0, TOP_N);

    // Точный модуль 6 для лидеров, с ленивым пропуском (CELF).
    let bestE = null;
    let bestObj = -Infinity;
    let exact = 0;
    const budgetLeft = budget - spent - (N - m) * minCapex;
    const order = [...shortlist].sort((a, b) => (bound.get(b.l.id) ?? Infinity) - (bound.get(a.l.id) ?? Infinity));
    for (const { l } of order) {
      if ((bound.get(l.id) ?? Infinity) <= bestObj) continue;
      const ev = evaluateCandidate({ candidateBase: { id: 'CAND', lat: l.lat, lon: l.lon, operator: 'новая', status: 'active' }, cells, centers, params, getBaseline, dist04Meters: l.dist04_m });
      exact++;
      const { e, accFlag } = bestConfig(ev, budgetLeft);
      const obj = e ? objective(e) : -Infinity;
      bound.set(l.id, obj);
      if (obj > bestObj) {
        bestObj = obj;
        bestE = { l, ev, e, accFlag };
      }
    }
    if (!bestE) {
      const cheapest = Math.min(...Object.values(CATALOG).map((c) => c.C_eq_mln_rub * 1e6 + c.P_cap_kW * params.M5_grid.c_A_rub_per_kW.min)) + (m7.C_site_mln_rub.value + m7.C_int_mln_rub.value) * 1e6;
      stoppedReason =
        budgetLeft < cheapest
          ? `бюджет исчерпан: потрачено ${(spent / 1e6).toFixed(1)} из ${(budget / 1e6).toFixed(1)} млн ₽ (бюджет = CAPEX традиционного подхода, раздел 10.3)`
          : 'у всех лидеров отбора нет допустимой конфигурации в пределах бюджета';
      console.log(`  шаг ${m}: ${stoppedReason}`);
      break;
    }
    if (bestObj <= 0) {
      stoppedReason = `на шаге ${m} новые станции уже не добавляют сети обслуженного спроса - только переманивают у соседей`;
      console.log(`  ${stoppedReason}`);
      break;
    }
    const pick = { ...summarize(bestE.l, bestE.ev, bestE.e), ...economicsRange(bestE.e) };
    pick.P_post_kW = bestE.e.cfg.P_post_kW;
    pick.acc_2030_below_target = bestE.accFlag;
    pick.new_demand_2026 = Number(newDemand(bestE.e, 2026).toFixed(2));
    pick.new_demand_2030 = Number(newDemand(bestE.e, 2030).toFixed(2));
    pick.new_demand_per_mln = Number(bestObj.toFixed(3));
    picks.push(pick);
    spent += bestE.e.scenarios.low.CAPEXrub;
    console.log(`  #${m} ${pick.id} ${pick.kind} ${pick.district} ${pick.omega} (класс ${pick.cls}): новый спрос ${pick.new_demand_2026} → ${pick.new_demand_2030} сес/сут (${pick.new_demand_per_mln} на млн ₽), S26=${pick.S_2026}; экономика: ${pick.econ_verdict}; точных оценок ${exact}, ${elapsed()}`);
    onStep({ picks, stoppedReason, shortlist: screened.slice(0, 30).map((s) => ({ id: s.l.id, screen: Number(s.screen.toFixed(3)) })) });
  }
  return { picks, stoppedReason, spent_rub: spent };
}

// ---------- Метрики (10.4 + доступность из критерия задания) ----------
// Сеть после добавления станций, базовый сценарий, 2028, средний день года.
//  - загрузка U (по постам), обслуженные сессии сети;
//  - доступность: доля всего спроса, обслуженная сетью (остальное - уехали
//    "вне сети" или отказ из-за переполнения), доля отказов из-за очереди
//    среди приехавших, среднее ожидание (по приехавшим) за сутки и в пиковый
//    час города.
function metrics(picks, tag, year = 2028) {
  const extra = picks.map((p) => asStation(p, p, tag));
  const acc = { U: new Float64Array(baseStations.length + extra.length), S: 0, demand: 0, arrivals: 0, lost: 0, wait: 0, peakWait: 0, peakArr: 0 };
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
          acc.wait += w * arrivals[k] * res.qh.W[k];
        }
        acc.U[j] += (w * u) / 24;
      }
      const peak = byHour.indexOf(Math.max(...byHour));
      for (let j = 0; j < n; j++) {
        acc.peakWait += w * arrivals[j * 24 + peak] * res.qh.W[j * 24 + peak];
        acc.peakArr += w * arrivals[j * 24 + peak];
      }
      let demand = 0;
      for (const s of Object.keys(res.demand)) for (const v of res.demand[s]) demand += v;
      acc.demand += w * demand;
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
  const allIdx = stations.map((_, j) => j);
  const sum = (k) => picks.reduce((a, p) => a + (p[k] || 0), 0);
  return {
    n: picks.length,
    U_new_mean: Number(wMean(newIdx).toFixed(4)),
    U_network_mean: Number(wMean(allIdx).toFixed(4)),
    share_new_U_below_20: picks.length ? Number((newIdx.filter((j) => acc.U[j] < 0.2).length / picks.length).toFixed(3)) : null,
    sessions_per_day_network: Math.round(acc.S),
    served_share_of_demand: Number((acc.S / acc.demand).toFixed(4)),
    queue_loss_share: Number((acc.lost / acc.arrivals).toFixed(4)),
    wait_min_mean: Number(((acc.wait / acc.arrivals) * 60).toFixed(2)),
    wait_min_peak: Number(((acc.peakWait / acc.peakArr) * 60).toFixed(2)),
    NPV_low_total_rub: sum('NPV_low_rub'),
    NPV_high_total_rub: sum('NPV_high_rub'),
    NPV_pel_min_total_rub: sum('NPV_pel_min_rub'),
    NPV_pel_max_total_rub: sum('NPV_pel_max_rub'),
    CAPEX_total_rub: sum('CAPEX_rub'),
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
// Сценарий по годам (задание: "сценарный анализ развития сети на несколько
// лет вперёд"): обслуженный спрос сети и его доля в 2026 и 2030 рядом с 2028.
out.metrics_by_year = {};
for (const year of [2026, 2028, 2030]) {
  const m = year === 2028 ? out.metrics : { baseline: metrics([], 'X', year), traditional: metrics(out.traditional.picks, 'T', year), model: metrics(out.model.picks, 'M', year) };
  out.metrics_by_year[year] = Object.fromEntries(['baseline', 'traditional', 'model'].map((k) => [k, { sessions_per_day_network: m[k].sessions_per_day_network, served_share_of_demand: m[k].served_share_of_demand, U_new_mean: m[k].U_new_mean, wait_min_peak: m[k].wait_min_peak }]));
  console.log(year, JSON.stringify(out.metrics_by_year[year]));
}
console.log(JSON.stringify(out.metrics, null, 1));
out.status = 'done';
save(out);
console.log(`готово за ${elapsed()} → data/portfolio.json`);
