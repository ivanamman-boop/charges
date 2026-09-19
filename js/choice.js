// Модуль 2. Выбор станции, модель Хаффа с внешней альтернативой
// (спецификация, раздел 4). Чистые функции, без DOM.
import { SEGMENTS } from './demand.js';

const R_EARTH_KM = 6371;
const LN2 = Math.LN2;
const SAME_CELL_KM = 0.38; // среднее расстояние внутри квадрата 1x1 км (4.3)

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// 4.3. Расстояние по дороге (haversine * rho), без поправки на "своя ячейка".
export function haversineKm(aLat, aLon, bLat, bLon) {
  const dPhi = toRad(bLat - aLat);
  const dPsi = toRad(bLon - aLon);
  const phi1 = toRad(aLat);
  const phi2 = toRad(bLat);
  const sinDPhi = Math.sin(dPhi / 2);
  const sinDPsi = Math.sin(dPsi / 2);
  const h = sinDPhi * sinDPhi + Math.cos(phi1) * Math.cos(phi2) * sinDPsi * sinDPsi;
  return 2 * R_EARTH_KM * Math.asin(Math.sqrt(Math.min(1, h)));
}

// Привязка каждой станции к ближайшей ячейке ("своя ячейка" для 4.3).
export function assignStationsToCells(stations, cells) {
  const homeCell = new Int32Array(stations.length);
  for (let j = 0; j < stations.length; j++) {
    let best = -1;
    let bestD = Infinity;
    const sj = stations[j];
    for (let i = 0; i < cells.length; i++) {
      const d = haversineKm(sj.lat, sj.lon, cells[i].lat, cells[i].lon);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    homeCell[j] = best;
  }
  return homeCell;
}

// 4.2. Привлекательность станции A_{s,j}. o_j зависит от сегмента (такси на
// станциях РСЗС) — поэтому считаем ln(A) отдельно на каждый сегмент.
export function buildLnAttractiveness({ stations, params }) {
  const m2 = params.M2_choice;
  const alphaP = m2.alpha_P.value;
  const alphaC = m2.alpha_c.value;
  const alphaRub = m2.alpha_rub.value;
  const pVeh = params.M3_queue.P_veh_kW;
  const tariff = m2.taxi_tariff_ratio;
  const oTaxiRSZS = Math.pow(tariff.value_default / tariff.value_RSZS, alphaRub);

  const result = {};
  for (const s of SEGMENTS) {
    const pVehS = s === 'T' ? pVeh.T.value : pVeh.P_C.value;
    const arr = new Float64Array(stations.length);
    for (let j = 0; j < stations.length; j++) {
      const st = stations[j];
      const powerTerm = Math.pow(Math.min(st.P_post_kW, pVehS) / 60, alphaP);
      const postsTerm = Math.pow(st.posts, alphaC);
      const o = s === 'T' && st.operator === 'РСЗС' ? oTaxiRSZS : 1;
      const A = powerTerm * postsTerm * o;
      arr[j] = Math.log(A);
    }
    result[s] = arr;
  }
  return result;
}

// 4.4. Усечённые списки J_i (станции в радиусе Rmax = 4*d_half_s) на каждую
// ячейку и сегмент, с расстояниями d_ij (уже с учётом rho и "своей ячейки").
export function buildNeighborIndex({ cells, stations, params, homeCell }) {
  const m2 = params.M2_choice;
  const rho = m2.rho_road_factor.value;
  const result = {};
  for (const s of SEGMENTS) {
    const dHalf = m2.d_half_km[s].value;
    const Rmax = 4 * dHalf;
    const perCell = new Array(cells.length);
    for (let i = 0; i < cells.length; i++) {
      const idxList = [];
      const dList = [];
      for (let j = 0; j < stations.length; j++) {
        const isHome = homeCell[j] === i;
        const raw = haversineKm(cells[i].lat, cells[i].lon, stations[j].lat, stations[j].lon);
        const d = isHome ? SAME_CELL_KM * rho : raw * rho; // 4.3, d уже с учётом rho
        if (d > Rmax && !isHome) continue; // 4.4, усечение по Rmax = 4*d_half
        idxList.push(j);
        dList.push(d);
      }
      perCell[i] = { idx: Int32Array.from(idxList), d: Float64Array.from(dList) };
    }
    result[s] = perCell;
  }
  return result;
}

// 4.1. Вероятности выбора P_{s,ij}(h) и P_{s,i0}(h) для одной (сегмент,
// ячейка, час). Используется и в горячем цикле huff(), и напрямую в Т2.
export function cellHourProbabilities({ idx, d, activeStations, lnAs, beta, gamma, Vi0, W, hour }) {
  const n = idx.length;
  const v = new Float64Array(n);
  let vMax = Vi0;
  for (let k = 0; k < n; k++) {
    const j = idx[k];
    if (!activeStations[j]) {
      v[k] = -Infinity;
      continue;
    }
    v[k] = lnAs[j] - beta * d[k] - gamma * W[j * 24 + hour];
    if (v[k] > vMax) vMax = v[k];
  }
  const P = new Float64Array(n);
  let expSum = Math.exp(Vi0 - vMax);
  for (let k = 0; k < n; k++) {
    if (v[k] === -Infinity) continue;
    P[k] = Math.exp(v[k] - vMax);
    expSum += P[k];
  }
  for (let k = 0; k < n; k++) P[k] /= expSum;
  const P0 = Math.exp(Vi0 - vMax) / expSum;
  return { P, P0 };
}

// 6.1/4.5. Один проход Хаффа для всех сегментов и часов при заданном W.
// demand: { segment: Float64Array(nCells*24) } из demand.js
// W: Float64Array(nStations*24), текущая оценка ожидания по станциям и часам
// activeStations: Uint8Array(nStations) — 1, если станция учитывается в сети
// (действует в этом году, year_open <= y); неактивные исключаются.
export function huff({ cells, stations, params, demand, W, neighborIndex, lnA, activeStations }) {
  const m2 = params.M2_choice;
  const bySegment = {};
  const out = {};
  const nStations = stations.length;

  for (const s of SEGMENTS) {
    const beta = LN2 / m2.d_half_km[s].value;
    const Whalf = m2.W_half_min[s === 'P0' || s === 'P1' ? 'P' : s].value / 60; // ч
    const gamma = LN2 / Whalf;
    const Vi0 = -beta * m2.d0_km.value;
    const neighbors = neighborIndex[s];
    const lnAs = lnA[s];
    const demS = demand[s];
    const lamS = new Float64Array(nStations * 24);
    const outS = new Float64Array(24);

    for (let i = 0; i < cells.length; i++) {
      const { idx, d } = neighbors[i];
      const n = idx.length;
      for (let h = 0; h < 24; h++) {
        const lamSI = demS[i * 24 + h];
        if (lamSI === 0) continue;

        const { P, P0 } = cellHourProbabilities({ idx, d, activeStations, lnAs, beta, gamma, Vi0, W, hour: h });
        for (let k = 0; k < n; k++) {
          if (P[k] === 0) continue;
          lamS[idx[k] * 24 + h] += lamSI * P[k];
        }
        outS[h] += lamSI * P0;
      }
    }
    bySegment[s] = lamS;
    out[s] = outS;
  }
  return { bySegment, out };
}
