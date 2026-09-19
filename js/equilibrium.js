// Модуль 4. Равновесие сети (спецификация, раздел 6.1). Чистые функции.
import { SEGMENTS, demandField } from './demand.js';
import { assignStationsToCells, buildNeighborIndex, buildLnAttractiveness, huff } from './choice.js';
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
