// Модуль 4. Равновесие сети (спецификация, раздел 6.1). Чистые функции.
import { SEGMENTS, demandField } from './demand.js';
import { assignStationsToCells, buildNeighborIndex, buildLnAttractiveness, haversineKm, huff } from './choice.js';
import { sessionMetrics as queueSessionMetrics, hourlyAverages, queueHour } from './queue.js';

// Геометрия сети (соседи, привлекательность) не зависит от года/сезона/дня —
// считаем один раз и переиспользуем во всех равновесиях и при калибровке D0.
export function buildNetworkContext({ cells, stations, params }) {
  const homeCell = assignStationsToCells(stations, cells);
  const neighborIndex = buildNeighborIndex({ cells, stations, params, homeCell });
  const lnA = buildLnAttractiveness({ stations, params });
  return { homeCell, neighborIndex, lnA };
}

export function buildActiveMask(stations, year) {
  const mask = new Uint8Array(stations.length);
  for (let j = 0; j < stations.length; j++) mask[j] = stations[j].year_open <= year ? 1 : 0;
  return mask;
}

const SEGMENT_E_GROUP = { P0: 'P0_P1_C', P1: 'P0_P1_C', C: 'P0_P1_C', T: 'T' };
const SEGMENT_VEH_GROUP = { P0: 'P_C', P1: 'P_C', C: 'P_C', T: 'T' };

// 5.1. pi/tau по станции и сегменту, при заданном сезоне (не зависит от часа).
export function buildSessionMetrics({ stations, params, season }) {
  const m3 = params.M3_queue;
  const kappaE = season === 'winter' ? m3.kappa_winter.E.value : 1;
  const kappaP = season === 'winter' ? m3.kappa_winter.P.value : 1;
  const phi = m3.phi.value;
  const t0 = m3.t0_min.value / 60;
  const result = {};
  for (const s of SEGMENTS) {
    const e = m3.e_kWh[SEGMENT_E_GROUP[s]].value;
    const pVeh = m3.P_veh_kW[SEGMENT_VEH_GROUP[s]].value;
    const pi = new Float64Array(stations.length);
    const tau = new Float64Array(stations.length);
    for (let j = 0; j < stations.length; j++) {
      const m = queueSessionMetrics({ P_post: stations[j].P_post_kW, P_veh: pVeh, phi, kappaP, e, kappaE, t0 });
      pi[j] = m.pi;
      tau[j] = m.tau;
    }
    result[s] = { pi, tau };
  }
  return result;
}

// 5.2-5.5. Показатели часа для всех станций при заданном lam (модуль 2).
export function computeQueueForAllStations({ stations, params, lam, sessionMetrics, activeStations }) {
  const m3 = params.M3_queue;
  const Q = m3.Q_waiting_slots.value;
  const a = m3.a_tech.value * (1 - m3.b_ICE.value);
  const T = m3.T_threshold_min.value / 60;
  const nStations = stations.length;

  const W = new Float64Array(nStations * 24);
  const lambdaSrv = new Float64Array(nStations * 24);
  const Lq = new Float64Array(nStations * 24);
  const U = new Float64Array(nStations * 24);
  const Acc = new Float64Array(nStations * 24);
  const L = new Float64Array(nStations * 24);

  for (let j = 0; j < nStations; j++) {
    if (!activeStations[j]) continue;
    const st = stations[j];
    for (let h = 0; h < 24; h++) {
      const idx = j * 24 + h;
      const segs = SEGMENTS.map((s) => ({
        lambda: lam.bySegment[s][idx],
        pi: sessionMetrics[s].pi[j],
        tau: sessionMetrics[s].tau[j],
      }));
      const avg = hourlyAverages(segs);
      if (avg.lambdaTotal === 0) continue;
      const res = queueHour({ lambda: avg.lambdaTotal, c: st.posts, Q, a, mu: avg.mu, Pcap: st.P_kW, piBar: avg.piBar, T });
      W[idx] = res.W;
      lambdaSrv[idx] = res.lambdaSrv;
      Lq[idx] = res.Lq;
      U[idx] = res.U;
      Acc[idx] = res.Acc;
      L[idx] = res.L;
    }
  }
  return { W, lambdaSrv, Lq, U, Acc, L };
}

// 6.1. Неподвижная точка Хафф <-> Очередь с демпфированием.
export function equilibrium({ cells, stations, params, year, scenario, dayType, season, context }) {
  const { neighborIndex, lnA } = context;
  const activeStations = buildActiveMask(stations, year);
  const demand = demandField({ cells, params, year, scenario, dayType, season });
  const sessionMetrics = buildSessionMetrics({ stations, params, season });

  const nStations = stations.length;
  const maxIter = params.equilibrium.max_iterations;
  const convThresh = params.equilibrium.convergence_threshold_hours;

  function run(theta) {
    let W = new Float64Array(nStations * 24);
    let lam = null;
    let qh = null;
    let converged = false;
    let it = 0;
    for (it = 1; it <= maxIter; it++) {
      lam = huff({ cells, stations, params, demand, W, neighborIndex, lnA, activeStations });
      qh = computeQueueForAllStations({ stations, params, lam, sessionMetrics, activeStations });
      let delta = 0;
      const Wnew = qh.W;
      for (let k = 0; k < W.length; k++) {
        const d = Math.abs(Wnew[k] - W[k]);
        if (d > delta) delta = d;
        W[k] = W[k] + theta * (Wnew[k] - W[k]);
      }
      if (delta < convThresh) {
        converged = true;
        break;
      }
    }
    return { lam, qh, W, it, converged };
  }

  let result = run(params.equilibrium.theta_damping);
  if (!result.converged) {
    result = run(params.equilibrium.theta_damping_fallback);
  }

  return { ...result, demand, activeStations, sessionMetrics, year, scenario, dayType, season };
}

// 5.6. Суточные обслуженные сессии по станции S_j = sum_h lambda_srv_j(h).
export function dailySessions(lambdaSrv, nStations) {
  const S = new Float64Array(nStations);
  for (let j = 0; j < nStations; j++) {
    let sum = 0;
    for (let h = 0; h < 24; h++) sum += lambdaSrv[j * 24 + h];
    S[j] = sum;
  }
  return S;
}

// Полный приходящий поток λ_j(h) (до потерь на переполнении), сумма по сегментам.
export function totalArrivalPerStationHour(lam, nStations) {
  const total = new Float64Array(nStations * 24);
  for (const s of SEGMENTS) {
    const arr = lam.bySegment[s];
    for (let k = 0; k < total.length; k++) total[k] += arr[k];
  }
  return total;
}

// 6.2. Λ_lost = Σ_{j,h} λ_j(h)·p_K(h) = Σ_{j,h} (λ_j(h) - λ^srv_j(h)).
export function lostDemandTotal(lam, lambdaSrv, nStations) {
  const total = totalArrivalPerStationHour(lam, nStations);
  let sum = 0;
  for (let k = 0; k < total.length; k++) sum += total[k] - lambdaSrv[k];
  return sum;
}

// Λ_out = Σ_h Σ_s λ_out,s(h).
export function outsideDemandTotal(lam) {
  let sum = 0;
  for (const s of SEGMENTS) {
    const arr = lam.out[s];
    for (let h = 0; h < 24; h++) sum += arr[h];
  }
  return sum;
}

// 12.3. Ячейки в радиусе Rmax(кандидат) от каждого сегмента, объединённые по
// самому широкому сегменту (P0 по умолчанию) — станции в буферном радиусе
// stationBufferMult*Rmax (спецификация даёт "2*Rmax" как минимум; берём
// запас побольше, чтобы ослабить эффект жёсткой границы, см. Т8/journal.md).
export function candidateAffectedSets({ cells, stations, candidateLoc, params, stationBufferMult = 2, cellBufferMult = 1 }) {
  const m2 = params.M2_choice;
  const rho = m2.rho_road_factor.value;
  const RmaxMax = 4 * Math.max(...SEGMENTS.map((s) => m2.d_half_km[s].value));
  const affectedCellIdx = [];
  for (let i = 0; i < cells.length; i++) {
    const d = haversineKm(cells[i].lat, cells[i].lon, candidateLoc.lat, candidateLoc.lon) * rho;
    if (d <= cellBufferMult * RmaxMax) affectedCellIdx.push(i);
  }
  const affectedStationIdx = [];
  for (let j = 0; j < stations.length; j++) {
    const d = haversineKm(stations[j].lat, stations[j].lon, candidateLoc.lat, candidateLoc.lon) * rho;
    if (d <= stationBufferMult * RmaxMax) affectedStationIdx.push(j);
  }
  return { affectedCellIdx, affectedStationIdx, RmaxMax };
}

// 12.3. Локальный пересчёт равновесия вокруг кандидата: пересчитываются
// только ячейки в радиусе Rmax и станции в радиусе 2*Rmax, остальное берётся
// из готового опорного равновесия (fullResult/fullContext — сеть БЕЗ
// кандидата на тех же условиях year/scenario/dayType/season).
export function localEquilibrium({ cells, stations, candidate, params, year, scenario, dayType, season, fullContext, fullResult, stationBufferMult = 2, cellBufferMult = 1 }) {
  const { affectedCellIdx, affectedStationIdx } = candidateAffectedSets({
    cells,
    stations,
    candidateLoc: candidate,
    params,
    stationBufferMult,
    cellBufferMult,
  });

  // Шаг 1: декомпозиция базового вклада затронутых ячеек через полный
  // контекст (разово, не в цикле) — сколько станции j давали затронутые
  // ячейки в БАЗОВОМ равновесии.
  const zeroedDemand = {};
  for (const s of SEGMENTS) {
    const full = fullResult.demand[s];
    const z = new Float64Array(full.length);
    for (const i of affectedCellIdx) {
      const base = i * 24;
      for (let h = 0; h < 24; h++) z[base + h] = full[base + h];
    }
    zeroedDemand[s] = z;
  }
  const affectedContribBaseline = huff({
    cells,
    stations,
    params,
    demand: zeroedDemand,
    W: fullResult.W,
    neighborIndex: fullContext.neighborIndex,
    lnA: fullContext.lnA,
    activeStations: fullResult.activeStations,
  });

  // "Замороженная" часть потока от НЕзатронутых ячеек к затронутым станциям.
  const fixedPart = {};
  for (const s of SEGMENTS) {
    fixedPart[s] = new Map();
    for (const j of affectedStationIdx) {
      const arr = new Float64Array(24);
      const base = j * 24;
      for (let h = 0; h < 24; h++) arr[h] = fullResult.lam.bySegment[s][base + h] - affectedContribBaseline.bySegment[s][base + h];
      fixedPart[s].set(j, arr);
    }
  }
  const outsideFixed = {};
  for (const s of SEGMENTS) {
    outsideFixed[s] = new Float64Array(24);
    for (let h = 0; h < 24; h++) outsideFixed[s][h] = fullResult.lam.out[s][h] - affectedContribBaseline.out[s][h];
  }

  // Шаг 2: локальная сеть = затронутые станции + кандидат, затронутые ячейки.
  // "Своя ячейка" (4.3) должна определяться относительно ВСЕХ ячеек города,
  // а не только затронутых — иначе граничной станции ошибочно достанется
  // чужая "домашняя" ячейка с заниженным расстоянием 0.38*rho.
  const affectedCells = affectedCellIdx.map((i) => cells[i]);
  const affectedStations = affectedStationIdx.map((j) => stations[j]);
  const localStations = [...affectedStations, candidate];
  const candidateLocalIdx = localStations.length - 1;

  const globalHomeCell = assignStationsToCells(localStations, cells);
  const globalToLocalCell = new Map(affectedCellIdx.map((g, local) => [g, local]));
  const localHomeCell = new Int32Array(localStations.length).fill(-1);
  for (let j = 0; j < localStations.length; j++) {
    const g = globalHomeCell[j];
    if (globalToLocalCell.has(g)) localHomeCell[j] = globalToLocalCell.get(g);
  }
  const localContext = {
    neighborIndex: buildNeighborIndex({ cells: affectedCells, stations: localStations, params, homeCell: localHomeCell }),
    lnA: buildLnAttractiveness({ stations: localStations, params }),
  };

  const localDemand = {};
  for (const s of SEGMENTS) {
    const arr = new Float64Array(affectedCells.length * 24);
    const full = fullResult.demand[s];
    affectedCellIdx.forEach((globalI, localI) => {
      const gBase = globalI * 24;
      const lBase = localI * 24;
      for (let h = 0; h < 24; h++) arr[lBase + h] = full[gBase + h];
    });
    localDemand[s] = arr;
  }

  const localActiveMask = new Uint8Array(localStations.length).fill(1);
  const localSessionMetrics = buildSessionMetrics({ stations: localStations, params, season });
  const maxIter = params.equilibrium.max_iterations;
  const convThresh = params.equilibrium.convergence_threshold_hours;

  function run(theta) {
    const W = new Float64Array(localStations.length * 24);
    affectedStationIdx.forEach((globalJ, localJ) => {
      const gBase = globalJ * 24;
      const lBase = localJ * 24;
      for (let h = 0; h < 24; h++) W[lBase + h] = fullResult.W[gBase + h];
    });

    let lamLocal = null;
    let combined = null;
    let qh = null;
    let converged = false;
    let it = 0;
    for (it = 1; it <= maxIter; it++) {
      lamLocal = huff({
        cells: affectedCells,
        stations: localStations,
        params,
        demand: localDemand,
        W,
        neighborIndex: localContext.neighborIndex,
        lnA: localContext.lnA,
        activeStations: localActiveMask,
      });

      combined = { bySegment: {}, out: lamLocal.out };
      for (const s of SEGMENTS) {
        const arr = Float64Array.from(lamLocal.bySegment[s]);
        affectedStationIdx.forEach((globalJ, localJ) => {
          const fp = fixedPart[s].get(globalJ);
          const lBase = localJ * 24;
          for (let h = 0; h < 24; h++) arr[lBase + h] += fp[h];
        });
        combined.bySegment[s] = arr;
      }

      qh = computeQueueForAllStations({ stations: localStations, params, lam: combined, sessionMetrics: localSessionMetrics, activeStations: localActiveMask });

      let delta = 0;
      const Wnew = qh.W;
      for (let k = 0; k < W.length; k++) {
        const d = Math.abs(Wnew[k] - W[k]);
        if (d > delta) delta = d;
        W[k] = W[k] + theta * (Wnew[k] - W[k]);
      }
      if (delta < convThresh) {
        converged = true;
        break;
      }
    }
    return { lamLocal, combined, qh, W, it, converged };
  }

  let result = run(params.equilibrium.theta_damping);
  if (!result.converged) {
    result = run(params.equilibrium.theta_damping_fallback);
  }

  const S_local = dailySessions(result.qh.lambdaSrv, localStations.length);

  let lambdaOutNew = 0;
  for (const s of SEGMENTS) for (let h = 0; h < 24; h++) lambdaOutNew += outsideFixed[s][h] + result.lamLocal.out[s][h];
  const lambdaOutBaseline = outsideDemandTotal(fullResult.lam);
  const deltaLambdaOut = lambdaOutNew - lambdaOutBaseline;

  const fullTotalArrival = totalArrivalPerStationHour(fullResult.lam, stations.length);
  let lambdaLostBaselineLocal = 0;
  for (const j of affectedStationIdx) {
    const base = j * 24;
    for (let h = 0; h < 24; h++) lambdaLostBaselineLocal += fullTotalArrival[base + h] - fullResult.qh.lambdaSrv[base + h];
  }
  const lambdaLostNewLocal = lostDemandTotal(result.combined, result.qh.lambdaSrv, localStations.length);
  const deltaLambdaLost = lambdaLostNewLocal - lambdaLostBaselineLocal;

  return {
    ...result,
    affectedCellIdx,
    affectedStationIdx,
    localStations,
    candidateLocalIdx,
    S_local,
    deltaLambdaOut,
    deltaLambdaLost,
  };
}
