// Кнопка «Запустить тесты» (спецификация, раздел 13). Браузерная версия
// тестов Т1-Т10 — чистые функции из js/*.js, без DOM. Т8 запускается в
// сокращённом виде (3 кандидата), Т10 - с урезанным каталогом оборудования;
// полные версии — в tests/*.js через `npm test` (Node). Т11 ждёт данных.
import { SEGMENTS, segmentDemand, demandField } from './demand.js';
import {
  haversineKm,
  assignStationsToCells,
  buildNeighborIndex,
  buildLnAttractiveness,
  cellHourProbabilities,
  huff,
} from './choice.js';
import { queueChainCore, sessionMetrics as queueSessionMetrics } from './queue.js';
import { evaluateCandidate } from './equipment.js';
import {
  buildActiveMask,
  buildNetworkContext,
  equilibrium,
  localEquilibrium,
  dailySessions,
  lostDemandTotal,
  outsideDemandTotal,
  totalArrivalPerStationHour,
} from './equilibrium.js';
import { marginPerSession, sessionDurationHours, capexRub, opexFixYearRub, breakeven, monthlyCashFlow, npv, crf } from './economics.js';

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function kendallTau(a, b) {
  let concordant = 0, discordant = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sa = Math.sign(a[i] - a[j]);
      const sb = Math.sign(b[i] - b[j]);
      if (sa === 0 || sb === 0) continue;
      if (sa === sb) concordant++;
      else discordant++;
    }
  }
  return (concordant - discordant) / (n * (n - 1) / 2);
}

function sumLam(lamBySegment, idx) {
  let sum = 0;
  for (const s of SEGMENTS) for (let h = 0; h < 24; h++) sum += lamBySegment[s][idx * 24 + h];
  return sum;
}

// --- Т1. Сохранение спроса ---
function testT1({ cells, params }) {
  const M_GROUP = { P0: 'P', P1: 'P', T: 'T', C: 'C' };
  const cases = [
    { year: 2026, scenario: 'base', dayType: 'weekday', season: 'summer' },
    { year: 2030, scenario: 'optimistic', dayType: 'weekend', season: 'winter' },
  ];
  let worst = 0;
  for (const c of cases) {
    const demand = demandField({ cells, params, ...c });
    for (const s of SEGMENTS) {
      const Ds = segmentDemand(s, c.year, c.scenario, params);
      const m = c.dayType === 'weekend' ? params.M1_demand.m_weekday_weekend[M_GROUP[s]].value_weekend : params.M1_demand.m_weekday_weekend[M_GROUP[s]].value_weekday;
      const zeta = params.M1_demand.zeta_season[c.season].value;
      const expected = Ds * m * zeta;
      let sum = 0;
      const arr = demand[s];
      for (let k = 0; k < arr.length; k++) sum += arr[k];
      const relError = expected !== 0 ? Math.abs(sum - expected) / Math.abs(expected) : Math.abs(sum);
      if (relError > worst) worst = relError;
    }
  }
  return { id: 'T1', name: 'Т1: сохранение спроса в М1', pass: worst < 1e-9, detail: `худшая отн. ошибка ${worst.toExponential(2)}` };
}

// --- Т2. Вероятности Хаффа ---
function testT2({ cells, stations, params }) {
  const active = stations.filter((s) => s.year_open <= 2026);
  const activeStations = new Uint8Array(active.length).fill(1);
  const homeCell = assignStationsToCells(active, cells);
  const neighborIndex = buildNeighborIndex({ cells, stations: active, params, homeCell });
  const lnA = buildLnAttractiveness({ stations: active, params });
  const W = new Float64Array(active.length * 24);
  const m2 = params.M2_choice;
  let worst = 0;
  let checked = 0;
  for (const s of SEGMENTS) {
    const beta = Math.LN2 / m2.d_half_km[s].value;
    const Whalf = m2.W_half_min[s === 'P0' || s === 'P1' ? 'P' : s].value / 60;
    const gamma = Math.LN2 / Whalf;
    const Vi0 = -beta * m2.d0_km.value;
    for (let i = 0; i < cells.length; i += 130) {
      const { idx, d } = neighborIndex[s][i];
      for (let h = 0; h < 24; h += 6) {
        const { P, P0 } = cellHourProbabilities({ idx, d, activeStations, lnAs: lnA[s], beta, gamma, Vi0, W, hour: h });
        let sum = P0;
        for (let k = 0; k < P.length; k++) sum += P[k];
        const err = Math.abs(sum - 1);
        if (err > worst) worst = err;
        checked++;
      }
    }
  }
  return { id: 'T2', name: 'Т2: вероятности Хаффа суммируются в 1', pass: worst < 1e-12, detail: `${checked} комбинаций, худшее отклонение ${worst.toExponential(2)}` };
}

// --- Т3. Цепь против Erlang-C ---
function testT3() {
  function factorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
  function erlangCWait(a, c) {
    const rho = a / c;
    if (rho >= 1) return null;
    let sum = 0;
    for (let k = 0; k < c; k++) sum += Math.pow(a, k) / factorial(k);
    const last = Math.pow(a, c) / factorial(c) / (1 - rho);
    return last / (sum + last);
  }
  const ratios = [0.5, 1.5, 2.5];
  const cValues = [1, 2, 4];
  const mu = 1, K = 200, T = 10 / 60;
  let worst = 0;
  let checked = 0;
  for (const c of cValues) {
    for (const a of ratios) {
      const rho = a / c;
      if (rho >= 1) continue;
      const lambda = a * mu;
      const piBar = 1, Pcap = c * piBar, Q = K - c;
      const chain = queueChainCore({ lambda, cPrime: c, cTotal: c, Q, mu, Pcap, piBar, T });
      const Pwait = erlangCWait(a, c);
      const wErlang = Pwait / (c * mu - lambda);
      const relError = Math.abs(chain.W - wErlang) / wErlang;
      if (relError > worst) worst = relError;
      checked++;
    }
  }
  return { id: 'T3', name: 'Т3: цепь M/M/c/K против Erlang-C', pass: worst < 0.001, detail: `${checked} комбинаций, худшая отн. ошибка ${(worst * 100).toFixed(4)}%` };
}

// --- Т4. Баланс при добавлении станции ---
function testT4({ cells, stations, params, fullContext, fullResult }) {
  const candidate = { id: 'T4-CANDIDATE', lat: 55.751, lon: 37.618, operator: 'РСЗС', P_kW: 60, posts: 2, P_post_kW: 60, status: 'candidate', year_open: fullResult.year };
  const withCandidate = [...stations, candidate];
  const ctx1 = buildNetworkContext({ cells, stations: withCandidate, params });
  const r1 = equilibrium({ cells, stations: withCandidate, params, year: fullResult.year, scenario: fullResult.scenario, dayType: fullResult.dayType, season: fullResult.season, context: ctx1 });

  const S0 = dailySessions(fullResult.qh.lambdaSrv, stations.length);
  const S1 = dailySessions(r1.qh.lambdaSrv, withCandidate.length);
  let sumDeltaS = S1[withCandidate.length - 1];
  for (let j = 0; j < stations.length; j++) sumDeltaS += S1[j] - S0[j];

  const deltaLambdaOut = outsideDemandTotal(r1.lam) - outsideDemandTotal(fullResult.lam);
  const lambdaLost0 = lostDemandTotal(fullResult.lam, fullResult.qh.lambdaSrv, stations.length);
  const lambdaLost1 = lostDemandTotal(r1.lam, r1.qh.lambdaSrv, withCandidate.length);
  const deltaLambdaLost = lambdaLost1 - lambdaLost0;

  const lhs = sumDeltaS;
  const rhs = -deltaLambdaOut - deltaLambdaLost;
  const residual = Math.abs(lhs - rhs);
  return { id: 'T4', name: 'Т4: баланс при добавлении станции', pass: residual < 1e-6, detail: `невязка ${residual.toExponential(2)} сессии` };
}

// --- Т5. Ручной расчёт на fixture hand5.json ---
async function testT5({ params }) {
  const fixture = await fetch('tests/fixtures/hand5.json').then((r) => r.json());
  const { cells, stations } = fixture;
  const YEAR = 2026, SCENARIO = 'base', DAY_TYPE = 'weekday', SEASON = 'summer', HOUR = 12;

  function haversineKmIndep(aLat, aLon, bLat, bLon) { return haversineKm(aLat, aLon, bLat, bLon); }
  const d1 = params.M1_demand;
  const D0 = d1.D0.value;
  const m2 = params.M2_choice;
  const m3 = params.M3_queue;

  function circularDeltaIndep(h, mu) { const d = Math.abs(h - mu); return Math.min(d, 24 - d); }
  function hourlyProfileIndep(segment, h) {
    const cfg = d1.hourly_profile_weekday[segment];
    let sum = 0, atH = 0;
    for (let hh = 0; hh < 24; hh++) {
      let v = cfg.b;
      for (const peak of cfg.peaks) { const delta = circularDeltaIndep(hh, peak.mu); v += peak.A * Math.exp(-(delta * delta) / (2 * peak.sigma * peak.sigma)); }
      if (d1.hourly_correction_weekday) v *= d1.hourly_correction_weekday.value[hh];
      sum += v;
      if (hh === h) atH = v;
    }
    return atH / sum;
  }
  const M_GROUP = { P0: 'P', P1: 'P', T: 'T', C: 'C' };
  const expectedLambdaSI = {};
  for (const s of SEGMENTS) {
    const theta = d1.theta[s].value;
    const Ds = theta * D0;
    const m = d1.m_weekday_weekend[M_GROUP[s]].value_weekday;
    const zeta = d1.zeta_season[SEASON].value;
    const p = hourlyProfileIndep(s, HOUR);
    const a = d1.layer_weights[s];
    const layers = ['res', 'work', 'poi', 'road', 'taxi'];
    const rawW = cells.map((c) => layers.reduce((acc, l) => acc + a[l] * c.layers[l], 0));
    const sumW = rawW.reduce((x, y) => x + y, 0);
    const w = rawW.map((x) => x / sumW);
    expectedLambdaSI[s] = w.map((wi) => Ds * wi * m * zeta * p);
  }

  const rho = m2.rho_road_factor.value;
  const distances = cells.map((c, i) => (i === 0 ? 0.38 * rho : haversineKmIndep(c.lat, c.lon, stations[0].lat, stations[0].lon) * rho));
  const pVeh = m3.P_veh_kW;
  const tariff = m2.taxi_tariff_ratio;
  function attractivenessIndep(segment, station) {
    const pVehS = segment === 'T' ? pVeh.T.value : pVeh.P_C.value;
    const powerTerm = Math.pow(Math.min(station.P_post_kW, pVehS) / 60, m2.alpha_P.value);
    const postsTerm = Math.pow(station.posts, m2.alpha_c.value);
    const o = segment === 'T' && station.operator === 'РСЗС' ? Math.pow(tariff.value_default / tariff.value_RSZS, m2.alpha_rub.value) : 1;
    return powerTerm * postsTerm * o;
  }
  const expectedLambdaSJ = {};
  for (const s of SEGMENTS) {
    const dHalf = m2.d_half_km[s].value;
    const beta = Math.LN2 / dHalf;
    const Rmax = 4 * dHalf;
    const Vi0 = -beta * m2.d0_km.value;
    const A = stations.map((st) => attractivenessIndep(s, st));
    const perStation = [0, 0];
    for (let i = 0; i < cells.length; i++) {
      const lamSI = expectedLambdaSI[s][i];
      const inRange = i === 0 || distances[i] <= Rmax;
      if (!inRange) continue;
      const V = A.map((Aj) => Math.log(Aj) - beta * distances[i]);
      const vMax = Math.max(Vi0, ...V);
      let expSum = Math.exp(Vi0 - vMax);
      const expV = V.map((v) => Math.exp(v - vMax));
      for (const e of expV) expSum += e;
      for (let j = 0; j < stations.length; j++) perStation[j] += lamSI * (expV[j] / expSum);
    }
    expectedLambdaSJ[s] = perStation;
  }

  const demand = demandField({ cells, params, year: YEAR, scenario: SCENARIO, dayType: DAY_TYPE, season: SEASON });
  const homeCell = assignStationsToCells(stations, cells);
  const neighborIndex = buildNeighborIndex({ cells, stations, params, homeCell });
  const lnA = buildLnAttractiveness({ stations, params });
  const W = new Float64Array(stations.length * 24);
  const activeStations = new Uint8Array(stations.length).fill(1);
  const result = huff({ cells, stations, params, demand, W, neighborIndex, lnA, activeStations });

  let worst = 0;
  for (const s of SEGMENTS) {
    for (let j = 0; j < stations.length; j++) {
      const diff = Math.abs(expectedLambdaSJ[s][j] - result.bySegment[s][j * 24 + HOUR]);
      if (diff > worst) worst = diff;
    }
  }
  return { id: 'T5', name: 'Т5: сверка с независимым расчётом (hand5.json)', pass: worst < 5e-5, detail: `макс. расхождение ${worst.toExponential(2)}` };
}

// --- Т6. "Не скоринг ли это" (сокращённая выборка) ---
// Те же 50 кандидатов и то же зерно, что в полной версии (tests/t6-*.js):
// на 10 кандидатах тау Кендалла слишком "зернистая" и прыгала через порог
// 0.9 от выборки к выборке (2030: 0.956 на 10 при 0.83 на 50, журнал 25.09).
function testT6({ cells, stations, params, year, scenario = 'base' }) {
  const N = 50;
  const flatParams = JSON.parse(JSON.stringify(params));
  for (const dayKey of ['hourly_profile_weekday', 'hourly_profile_weekend']) {
    for (const s of SEGMENTS) flatParams.M1_demand[dayKey][s] = { b: 1, peaks: [] };
  }
  delete flatParams.M1_demand.hourly_correction_weekday; // иначе r(h) снова делает профиль неплоским
  delete flatParams.M1_demand.hourly_correction_weekend;
  const rand = mulberry32(606);
  // Кандидат - случайная ячейка ± ~0.5 км (после обрезки по МКАД углы bbox вне области модели).
  const nearRandomCell = () => { const c = cells[Math.floor(rand() * cells.length)]; return { lat: c.lat + (rand() - 0.5) * 0.009, lon: c.lon + (rand() - 0.5) * 0.016 }; };
  const CONDITIONS = { scenario, dayType: 'weekday', season: 'summer' };

  const active = stations.filter((s) => s.year_open <= year);
  const fullContext = buildNetworkContext({ cells, stations: active, params });
  const fullResult = equilibrium({ cells, stations: active, params, year, ...CONDITIONS, context: fullContext });

  const valuesA = [], valuesB = [], valuesC = [];
  for (let k = 0; k < N; k++) {
    const candidate = { id: `T6-${k}`, ...nearRandomCell(), operator: 'РСЗС', P_kW: 60, posts: 1, P_post_kW: 60, status: 'candidate', year_open: year };

    const local = localEquilibrium({ cells, stations: active, candidate, params, year, ...CONDITIONS, fullContext, fullResult });
    valuesA.push(sumLam(local.combined.bySegment, local.candidateLocalIdx));

    const stationsWithCandidate = [...active, candidate];
    const homeCell = assignStationsToCells(stationsWithCandidate, cells);
    const neighborIndex = buildNeighborIndex({ cells, stations: stationsWithCandidate, params: flatParams, homeCell });
    const lnA = buildLnAttractiveness({ stations: stationsWithCandidate, params: flatParams });
    const flatDemand = demandField({ cells, params: flatParams, year, ...CONDITIONS });
    const W = new Float64Array(stationsWithCandidate.length * 24);
    const activeMask = new Uint8Array(stationsWithCandidate.length).fill(1);
    const lamFlat = huff({ cells, stations: stationsWithCandidate, params: flatParams, demand: flatDemand, W, neighborIndex, lnA, activeStations: activeMask });
    valuesB.push(sumLam(lamFlat.bySegment, stationsWithCandidate.length - 1));

    const ctxSolo = buildNetworkContext({ cells, stations: [candidate], params });
    const resSolo = equilibrium({ cells, stations: [candidate], params, year, ...CONDITIONS, context: ctxSolo });
    valuesC.push(sumLam(resSolo.lam.bySegment, 0));
  }

  const tauB = kendallTau(valuesA, valuesB);
  const tauC = kendallTau(valuesA, valuesC);
  const pass = tauB < 0.9 && tauC < 0.9;
  return {
    id: 'T6',
    name: `Т6: не скоринг ли это (${year}, ${scenario === 'optimistic' ? 'быстрый' : 'базовый'} рост, ${N} кандидатов)`,
    pass,
    detail: `тау(плоский профиль)=${tauB.toFixed(3)}, тау(без соседей)=${tauC.toFixed(3)}${!pass && scenario === 'base' ? ' — при слабой загрузке сети по разделу 14 может не пройти, это ожидаемо' : ''}`,
    // Жёстко - только 2030 при быстром росте: при базовом (30%/год) сеть
    // 2026 и 2030 загружена слабо, и ось времени почти не влияет (26.09).
    soft: scenario === 'base', // не блокирует общий вердикт
  };
}

// --- Т7. Формула S*/U* против помесячного расчёта ---
function testT7({ params }) {
  const SEGMENT = 'P0', SEASON = 'summer';
  const station = { P_post_kW: 60 };
  const posts = 1, CeqRub = 1.6e6, connCostRub = 600000;
  const marginBar = marginPerSession({ segment: SEGMENT, season: SEASON, params });
  const tauBar = sessionDurationHours({ segment: SEGMENT, station, season: SEASON, params });
  const CAPEXrub = capexRub({ CeqRub, connCostRub, params });
  const OPEXfixYearRub = opexFixYearRub({ posts, CeqRub, params });
  const { Sstar, CRF } = breakeven({ OPEXfixYearRub, CAPEXrub, marginBar, tauBarHours: tauBar, posts, params });

  const H = params.M6_M7_equipment_economics.H_years.value;
  const r = params.M6_M7_equipment_economics.r_discount_rate.value;
  const getSessions = (year, season, dayType, segment) => (segment === SEGMENT ? Sstar : 0);
  const marginBySegmentSeason = (segment) => (segment === SEGMENT ? marginBar : 0);
  const CF = monthlyCashFlow({ getSessions, marginBySegmentSeason, TconnMonths: 0, OPEXfixYearRub, startYear: 2026, H, r });
  const NPVactual = npv(CF, CAPEXrub, r);

  const netAnnual = CAPEXrub * CRF;
  let NPVpredicted = -CAPEXrub;
  for (let t = 1; t <= 12 * H; t++) NPVpredicted += netAnnual / 12 / Math.pow(1 + r, t / 12);

  const residual = Math.abs(NPVactual - NPVpredicted);
  const tolerance = 0.005 * CAPEXrub;
  return { id: 'T7', name: 'Т7: формула S*/U* против помесячного расчёта', pass: residual < tolerance, detail: `расхождение ${residual.toFixed(0)} ₽ (допуск ${tolerance.toFixed(0)})` };
}

// --- Т8. Локальный пересчёт против полного (сокращённая выборка) ---
function testT8({ cells, stations, params, fullContext, fullResult }) {
  const N = 3;
  const rand = mulberry32(77);
  // Кандидат - случайная ячейка ± ~0.5 км (после обрезки по МКАД углы bbox вне области модели).
  const nearRandomCell = () => { const c = cells[Math.floor(rand() * cells.length)]; return { lat: c.lat + (rand() - 0.5) * 0.009, lon: c.lon + (rand() - 0.5) * 0.016 }; };

  let worst = 0;
  for (let k = 0; k < N; k++) {
    const candidate = { id: `T8-${k}`, ...nearRandomCell(), operator: 'РСЗС', P_kW: 60, posts: 1, P_post_kW: 60, status: 'candidate', year_open: fullResult.year };
    const local = localEquilibrium({ cells, stations, candidate, params, year: fullResult.year, scenario: fullResult.scenario, dayType: fullResult.dayType, season: fullResult.season, fullContext, fullResult });

    const withCandidate = [...stations, candidate];
    const ctxFull = buildNetworkContext({ cells, stations: withCandidate, params });
    const resFull = equilibrium({ cells, stations: withCandidate, params, year: fullResult.year, scenario: fullResult.scenario, dayType: fullResult.dayType, season: fullResult.season, context: ctxFull });
    const Sfull = dailySessions(resFull.qh.lambdaSrv, withCandidate.length);

    const SnewLocal = local.S_local[local.candidateLocalIdx];
    const SnewFull = Sfull[withCandidate.length - 1];
    const errSnew = Math.abs(SnewLocal - SnewFull) / Math.max(SnewFull, 1e-9);
    if (errSnew > worst) worst = errSnew;
  }
  return { id: 'T8', name: `Т8: локальный пересчёт против полного (${N} кандидатов)`, pass: worst < 0.02, detail: `худшая ошибка S_new ${(worst * 100).toFixed(2)}%` };
}

// --- Т10. Монотонность (раздел 13): три свойства, которые обязана иметь
// любая разумная модель размещения.
//  (а) больше d^{1/2} (люди готовы ехать дальше) -> шире зона обслуживания
//      станций: больше пар ячейка-станция с заметной вероятностью выбора;
//  (б) больше поток λ -> ожидание W не уменьшается (очередь M/M/c/K);
//  (в) меньше свободной мощности центра питания R'_q -> рекомендуемое
//      оборудование не мощнее (модуль 6 не "перескакивает" вверх).
export function testT10({ cells, stations, params, year = 2026, fast = true }) {
  const details = [];

  // (а) Зона обслуживания, сегмент P1, 12:00, без очередей (W = 0).
  const zoneSize = (p) => {
    const ctx = buildNetworkContext({ cells, stations, params: p });
    const active = buildActiveMask(stations, year);
    const m2 = p.M2_choice;
    const beta = Math.LN2 / m2.d_half_km.P1.value;
    const gamma = Math.LN2 / (m2.W_half_min.P.value / 60);
    const Vi0 = -beta * m2.d0_km.value;
    const W = new Float64Array(stations.length * 24);
    let pairs = 0;
    for (let i = 0; i < cells.length; i++) {
      const { idx, d } = ctx.neighborIndex.P1[i];
      const { P } = cellHourProbabilities({ idx, d, activeStations: active, lnAs: ctx.lnA.P1, beta, gamma, Vi0, W, hour: 12 });
      for (let k = 0; k < idx.length; k++) if (P[k] > 0.01) pairs++;
    }
    return pairs;
  };
  const wider = JSON.parse(JSON.stringify(params));
  for (const s of SEGMENTS) wider.M2_choice.d_half_km[s].value *= 1.5;
  const z0 = zoneSize(params);
  const z1 = zoneSize(wider);
  const okA = z1 > z0;
  details.push(`(а) радиус ×1.5: пар ячейка-станция ${z0} → ${z1}`);

  // (б) W(λ) не убывает: c = 1, 2, 4 поста, λ от 0.1 до 6 машин/ч.
  let okB = true;
  for (const c of [1, 2, 4]) {
    let prev = -Infinity;
    for (let lambda = 0.1; lambda <= 6; lambda += 0.1) {
      const w = queueChainCore({ lambda, cPrime: c, cTotal: c, Q: params.M3_queue.Q_waiting_slots.value, mu: 1.5, Pcap: 150 * c, piBar: 150, T: 10 / 60 }).W;
      if (w < prev - 1e-12) okB = false;
      prev = w;
    }
  }
  details.push(`(б) ожидание при росте потока ${okB ? 'не убывает' : 'УБЫВАЕТ'}`);

  // (в) Та же точка, резерв ЦП большой и урезанный до ~120 кВт.
  const trimmed = JSON.parse(JSON.stringify(params));
  if (fast) trimmed.M6_M7_equipment_economics.catalog.configs = trimmed.M6_M7_equipment_economics.catalog.configs.filter((c) => ['DC60-2', 'DC150-2', 'DC300-4'].includes(c.omega));
  const cache = new Map();
  const getBaseline = (y, season, dayType) => {
    const key = `${y}|${season}|${dayType}`;
    if (!cache.has(key)) {
      const st = stations.filter((s) => s.year_open <= y);
      const context = buildNetworkContext({ cells, stations: st, params: trimmed });
      cache.set(key, { context, result: equilibrium({ cells, stations: st, params: trimmed, year: y, scenario: 'base', dayType, season, context }), stations: st });
    }
    return cache.get(key);
  };
  const c0 = cells[Math.floor(cells.length / 2)];
  const cand = { id: 'T10', lat: c0.lat, lon: c0.lon, operator: 'РСЗС', status: 'candidate' };
  const center = { id: 'T10-PS', lat: c0.lat + 0.001, lon: c0.lon, reserve_MVA: 40, bus_planned_kW: 0 };
  const recBig = evaluateCandidate({ candidateBase: cand, cells, centers: [center], params: trimmed, getBaseline, dist04Meters: 100 }).recommended;
  const recSmall = evaluateCandidate({ candidateBase: cand, cells, centers: [{ ...center, reserve_MVA: 0.13 }], params: trimmed, getBaseline, dist04Meters: 100 }).recommended;
  const pBig = recBig?.cfg.P_cap_kW ?? 0;
  const pSmall = recSmall?.cfg.P_cap_kW ?? 0;
  const okC = pSmall <= pBig;
  details.push(`(в) резерв 40 МВА → 0.13 МВА: рекомендуемая мощность ${pBig} → ${pSmall} кВт`);

  return { id: 'T10', name: 'Т10: монотонность (радиус, поток, резерв мощности)', pass: okA && okB && okC, detail: details.join('; ') };
}

// --- Т11. Сверка с фактом (раздел 13) - нужны сессии по станциям от РСЗС:
// ранговая корреляция Спирмена прогноза S_j с фактом, порог ρ_S >= 0.5
// фиксируется в журнале до проверки. Открытых данных по станциям нет.
export function testT11() {
  return { id: 'T11', name: 'Т11: сверка с фактическими сессиями станций', pass: false, pending: true, detail: 'ждёт данных: нужны сессии по каждой станции от РСЗС — сравним прогноз с фактом (корреляция Спирмена, порог 0.5)' };
}

// Полный прогон. onProgress(testResult) вызывается после каждого теста -
// удобно для живого обновления списка в UI. stations/fullContext/fullResult
// - текущее опорное равновесие приложения (state.stations/fullContext/
// fullResult в app.js), чтобы не считать его заново.
export async function runAllTests({ cells, stationsAll, stations, params, fullContext, fullResult, onProgress }) {
  const results = [];
  const push = (r) => { results.push(r); if (onProgress) onProgress(r); };

  push(testT1({ cells, params }));
  await new Promise((r) => setTimeout(r, 0));
  push(testT2({ cells, stations: stationsAll, params }));
  await new Promise((r) => setTimeout(r, 0));
  push(testT3());
  await new Promise((r) => setTimeout(r, 0));
  push(testT4({ cells, stations, params, fullContext, fullResult }));
  await new Promise((r) => setTimeout(r, 0));
  push(await testT5({ params }));
  await new Promise((r) => setTimeout(r, 0));
  push(testT6({ cells, stations: stationsAll, params, year: 2026 }));
  await new Promise((r) => setTimeout(r, 0));
  push(testT6({ cells, stations: stationsAll, params, year: 2030 }));
  push(testT6({ cells, stations: stationsAll, params, year: 2030, scenario: 'optimistic' }));
  await new Promise((r) => setTimeout(r, 0));
  push(testT7({ params }));
  await new Promise((r) => setTimeout(r, 0));
  push(testT8({ cells, stations, params, fullContext, fullResult }));
  await new Promise((r) => setTimeout(r, 0));
  push(testT10({ cells, stations: stationsAll, params }));
  push(testT11());

  return results;
}
