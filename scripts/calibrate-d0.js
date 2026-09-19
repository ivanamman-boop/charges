// Калибровка D0 (спецификация, раздел 3.5): бисекция так, чтобы среднее
// число обслуженных сессий на действующую быструю станцию в сутки совпало
// с S_obs. Весна считается сезоном "лето". Средний день = взвешенное
// будни/выходные (5/7, 2/7), чтобы D0 отвечал на вопрос про типичные сутки,
// а не только будний день.
//
// Запуск: node scripts/calibrate-d0.js [--write]

import { readFileSync, writeFileSync } from 'node:fs';
import { buildNetworkContext, equilibrium, dailySessions } from '../js/equilibrium.js';

const DATA_DIR = new URL('../data/', import.meta.url);
const cells = JSON.parse(readFileSync(new URL('cells.json', DATA_DIR))).cells;
const stationsAll = JSON.parse(readFileSync(new URL('stations.json', DATA_DIR))).stations;
const paramsPath = new URL('params.json', DATA_DIR);
const params = JSON.parse(readFileSync(paramsPath));

const YEAR = 2026;
const stations = stationsAll.filter((s) => s.year_open <= YEAR); // вся сеть 2026 (участвует в равновесии)
const existingIdx = stations.map((s, j) => (s.status === 'active' ? j : -1)).filter((j) => j >= 0); // J_ex

const S_OBS = params.M1_demand.S_obs.spring.value;
console.log(`S_obs = ${S_OBS}, |J_ex| = ${existingIdx.length}`);

const context = buildNetworkContext({ cells, stations, params });

function meanSForD0(D0) {
  params.M1_demand.D0.value = D0;
  const weekday = equilibrium({ cells, stations, params, year: YEAR, scenario: 'base', dayType: 'weekday', season: 'summer', context });
  const weekend = equilibrium({ cells, stations, params, year: YEAR, scenario: 'base', dayType: 'weekend', season: 'summer', context });
  const Swd = dailySessions(weekday.qh.lambdaSrv, stations.length);
  const Swe = dailySessions(weekend.qh.lambdaSrv, stations.length);
  let sum = 0;
  for (const j of existingIdx) sum += (5 * Swd[j] + 2 * Swe[j]) / 7;
  return sum / existingIdx.length;
}

function F(D0) {
  return meanSForD0(D0) - S_OBS;
}

let lo = S_OBS * existingIdx.length;
let hi = 20 * S_OBS * existingIdx.length;
let fLo = F(lo);
let fHi = F(hi);
console.log(`бракетинг: F(${lo.toFixed(0)})=${fLo.toFixed(4)}  F(${hi.toFixed(0)})=${fHi.toFixed(4)}`);

if (fLo > 0 || fHi < 0) {
  console.error('F не меняет знак на границах — диапазон бисекции неверен, проверить модель');
  process.exit(1);
}

let mid, fMid;
let iterations = 0;
while ((hi - lo) / mid > 0.001 || iterations === 0) {
  mid = (lo + hi) / 2;
  fMid = F(mid);
  if (fMid > 0) hi = mid;
  else lo = mid;
  iterations++;
  console.log(`  it ${iterations}: D0=${mid.toFixed(1)} meanS=${(fMid + S_OBS).toFixed(4)} F=${fMid.toFixed(5)}`);
  if (iterations > 40) break;
}

console.log(`\nD0 = ${mid.toFixed(2)} (${iterations} итераций бисекции)`);
console.log(`Итоговое среднее S по J_ex: ${(fMid + S_OBS).toFixed(4)} (цель ${S_OBS})`);

if (process.argv.includes('--write')) {
  const raw = JSON.parse(readFileSync(paramsPath));
  raw.M1_demand.D0.value = Number(mid.toFixed(2));
  raw.M1_demand.D0.source = `калибровка бисекцией (scripts/calibrate-d0.js), ${iterations} итераций, среднее S по J_ex=${(fMid + S_OBS).toFixed(3)} при S_obs=${S_OBS}`;
  writeFileSync(paramsPath, JSON.stringify(raw, null, 2));
  console.log('D0 записан в data/params.json');
}
