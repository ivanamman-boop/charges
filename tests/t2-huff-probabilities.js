// Т2. Вероятности Хаффа (спецификация, раздел 13).
// Σ_j P_ij + P_i0 = 1 с точностью 1e-12, для каждых s, i, h.
import { readFileSync } from 'node:fs';
import { SEGMENTS } from '../js/demand.js';
import {
  assignStationsToCells,
  buildNeighborIndex,
  buildLnAttractiveness,
  cellHourProbabilities,
} from '../js/choice.js';

const cells = JSON.parse(readFileSync(new URL('../data/cells.json', import.meta.url))).cells;
const stationsAll = JSON.parse(readFileSync(new URL('../data/stations.json', import.meta.url))).stations;
const params = JSON.parse(readFileSync(new URL('../data/params.json', import.meta.url)));

const stations = stationsAll.filter((s) => s.year_open <= 2026);
const activeStations = new Uint8Array(stations.length).fill(1);

const homeCell = assignStationsToCells(stations, cells);
const neighborIndex = buildNeighborIndex({ cells, stations, params, homeCell });
const lnA = buildLnAttractiveness({ stations, params });

// Случайное, но воспроизводимое W (часы неравны нулю, чтобы -gamma*W был не тривиален)
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
const rand = mulberry32(42);
const W = new Float64Array(stations.length * 24);
for (let k = 0; k < W.length; k++) W[k] = rand() * 0.2; // до ~12 минут ожидания

const m2 = params.M2_choice;
const LN2 = Math.LN2;

// Проверяем на выборке ячеек (каждая 37-я, чтобы покрыть разные размеры J_i)
// и на всех 24 часах, для всех 4 сегментов.
let worst = 0;
let checked = 0;
let allPassed = true;

for (const s of SEGMENTS) {
  const beta = LN2 / m2.d_half_km[s].value;
  const Whalf = m2.W_half_min[s === 'P0' || s === 'P1' ? 'P' : s].value / 60;
  const gamma = LN2 / Whalf;
  const Vi0 = -beta * m2.d0_km.value;
  const neighbors = neighborIndex[s];
  const lnAs = lnA[s];

  for (let i = 0; i < cells.length; i += 37) {
    const { idx, d } = neighbors[i];
    for (let h = 0; h < 24; h++) {
      const { P, P0 } = cellHourProbabilities({ idx, d, activeStations, lnAs, beta, gamma, Vi0, W, hour: h });
      let sum = P0;
      for (let k = 0; k < P.length; k++) sum += P[k];
      const err = Math.abs(sum - 1);
      if (err > worst) worst = err;
      checked++;
    }
  }
}

allPassed = worst < 1e-12;
console.log(`проверено комбинаций (s,i,h): ${checked}`);
console.log(`худшее отклонение от 1: ${worst.toExponential(3)}`);
console.log(allPassed ? 'Т2: ПРОЙДЕН' : 'Т2: ПРОВАЛЕН');
if (!allPassed) process.exit(1);
