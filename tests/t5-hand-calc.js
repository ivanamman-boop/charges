// Т5. Ручной расчёт (спецификация, раздел 13). Фикстура tests/fixtures/hand5.json
// (5 ячеек, 2 станции, один час). "Ожидаемые" значения получены независимой
// реализацией формул 3.2-3.4 и 4.1-4.3 прямо в этом файле (без импорта
// js/demand.js и js/choice.js), затем сверены с настоящим пайплайном.
// Совпадение требуется до 4 знаков после запятой.
import { readFileSync } from 'node:fs';
import { SEGMENTS, demandField } from '../js/demand.js';
import { assignStationsToCells, buildNeighborIndex, buildLnAttractiveness, huff } from '../js/choice.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/hand5.json', import.meta.url)));
const params = JSON.parse(readFileSync(new URL('../data/params.json', import.meta.url)));
const { cells, stations } = fixture;

const YEAR = 2026;
const SCENARIO = 'base';
const DAY_TYPE = 'weekday';
const SEASON = 'summer';
const HOUR = 12;

// ---------- независимая реализация (formulas 3.1-3.4, 4.1-4.3) ----------
const R_EARTH_KM = 6371;
function haversineKmIndep(aLat, aLon, bLat, bLon) {
  const toRad = (x) => (x * Math.PI) / 180;
  const dPhi = toRad(bLat - aLat);
  const dPsi = toRad(bLon - aLon);
  const phi1 = toRad(aLat);
  const phi2 = toRad(bLat);
  const h = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dPsi / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.sqrt(h));
}

const d1 = params.M1_demand;
const D0 = d1.D0.value;
const m2 = params.M2_choice;
const m3 = params.M3_queue;

function circularDeltaIndep(h, mu) {
  const d = Math.abs(h - mu);
  return Math.min(d, 24 - d);
}

function hourlyProfileIndep(segment, h) {
  const cfg = d1.hourly_profile_weekday[segment];
  let sum = 0;
  let atH = 0;
  for (let hh = 0; hh < 24; hh++) {
    let v = cfg.b;
    for (const peak of cfg.peaks) {
      const delta = circularDeltaIndep(hh, peak.mu);
      v += peak.A * Math.exp(-(delta * delta) / (2 * peak.sigma * peak.sigma));
    }
    sum += v;
    if (hh === h) atH = v;
  }
  return atH / sum;
}

const M_GROUP = { P0: 'P', P1: 'P', T: 'T', C: 'C' };
const GROWTH_PRIVATE_SEGMENTS = new Set(['P0', 'P1', 'C']);

const expectedLambdaSI = {}; // [segment] -> array по 5 ячейкам, час HOUR
for (const s of SEGMENTS) {
  const theta = d1.theta[s].value;
  const Ds = theta * D0; // year === y0, рост = 1
  const m = d1.m_weekday_weekend[M_GROUP[s]].value_weekday;
  const zeta = d1.zeta_season[SEASON].value;
  const p = hourlyProfileIndep(s, HOUR);
  const a = d1.layer_weights[s];
  const layers = ['res', 'work', 'poi', 'road', 'taxi'];

  // w_{s,i}: у каждой ячейки ровно один включённый слой -> w = a_{s,layer}
  const rawW = cells.map((c) => layers.reduce((acc, l) => acc + a[l] * c.layers[l], 0));
  const sumW = rawW.reduce((x, y) => x + y, 0);
  const w = rawW.map((x) => x / sumW);

  expectedLambdaSI[s] = w.map((wi) => Ds * wi * m * zeta * p);
}

// расстояния: cell 1 - "своя ячейка" (0.38*rho), cells 2-5 - haversine*rho
const rho = m2.rho_road_factor.value;
const distances = cells.map((c, i) =>
  i === 0 ? 0.38 * rho : haversineKmIndep(c.lat, c.lon, stations[0].lat, stations[0].lon) * rho
);

const pVeh = m3.P_veh_kW;
const tariff = m2.taxi_tariff_ratio;
function attractivenessIndep(segment, station) {
  const pVehS = segment === 'T' ? pVeh.T.value : pVeh.P_C.value;
  const powerTerm = Math.pow(Math.min(station.P_post_kW, pVehS) / 60, m2.alpha_P.value);
  const postsTerm = Math.pow(station.posts, m2.alpha_c.value);
  const o =
    segment === 'T' && station.operator === 'РСЗС'
      ? Math.pow(tariff.value_default / tariff.value_RSZS, m2.alpha_rub.value)
      : 1;
  return powerTerm * postsTerm * o;
}

const expectedLambdaSJ = {}; // [segment] -> [station][cell] вклад, час HOUR
for (const s of SEGMENTS) {
  const dHalf = m2.d_half_km[s].value;
  const beta = Math.LN2 / dHalf;
  const Rmax = 4 * dHalf; // 4.4, усечение J_i; своя ячейка (i=0) включается всегда
  const Vi0 = -beta * m2.d0_km.value; // W=0 => gamma*W=0
  const A = stations.map((st) => attractivenessIndep(s, st));
  const perStation = [0, 0];
  for (let i = 0; i < cells.length; i++) {
    const lamSI = expectedLambdaSI[s][i];
    const inRange = i === 0 || distances[i] <= Rmax;
    if (!inRange) continue; // станции вне J_i для этого сегмента не видны из ячейки i
    const V = A.map((Aj) => Math.log(Aj) - beta * distances[i]);
    const vMax = Math.max(Vi0, ...V);
    let expSum = Math.exp(Vi0 - vMax);
    const expV = V.map((v) => Math.exp(v - vMax));
    for (const e of expV) expSum += e;
    for (let j = 0; j < stations.length; j++) {
      perStation[j] += lamSI * (expV[j] / expSum);
    }
  }
  expectedLambdaSJ[s] = perStation;
}

// ---------- настоящий пайплайн (js/demand.js + js/choice.js) ----------
const demand = demandField({ cells, params, year: YEAR, scenario: SCENARIO, dayType: DAY_TYPE, season: SEASON });
const homeCell = assignStationsToCells(stations, cells);
const neighborIndex = buildNeighborIndex({ cells, stations, params, homeCell });
const lnA = buildLnAttractiveness({ stations, params });
const W = new Float64Array(stations.length * 24); // нулевое ожидание, один проход Хаффа
const activeStations = new Uint8Array(stations.length).fill(1);
const result = huff({ cells, stations, params, demand, W, neighborIndex, lnA, activeStations });

// ---------- сравнение ----------
let allPassed = true;
const rows = [];
for (const s of SEGMENTS) {
  for (let j = 0; j < stations.length; j++) {
    const expected = expectedLambdaSJ[s][j];
    const actual = result.bySegment[s][j * 24 + HOUR];
    const diff = Math.abs(expected - actual);
    const pass = diff < 5e-5; // совпадение до 4 знаков после запятой
    if (!pass) allPassed = false;
    rows.push({ segment: s, station: stations[j].id, expected: expected.toFixed(6), actual: actual.toFixed(6), diff: diff.toExponential(2), status: pass ? 'OK' : 'FAIL' });
  }
}

console.table(rows);
console.log(allPassed ? 'Т5: ПРОЙДЕН' : 'Т5: ПРОВАЛЕН');
if (!allPassed) process.exit(1);
