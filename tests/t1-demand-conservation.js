// Т1. Сохранение спроса в М1 (спецификация, раздел 13).
// Σ_i Σ_h λ(s,i,h) должно совпасть с D_s·m·zeta с точностью 1e-9 (отн. ошибка).
import { readFileSync } from 'node:fs';
import { SEGMENTS, segmentDemand, demandField } from '../js/demand.js';

const cells = JSON.parse(readFileSync(new URL('../data/cells.json', import.meta.url))).cells;
const params = JSON.parse(readFileSync(new URL('../data/params.json', import.meta.url)));

const M_GROUP = { P0: 'P', P1: 'P', T: 'T', C: 'C' };
const cases = [
  { year: 2026, scenario: 'base', dayType: 'weekday', season: 'summer' },
  { year: 2026, scenario: 'conservative', dayType: 'weekend', season: 'winter' },
  { year: 2030, scenario: 'optimistic', dayType: 'weekday', season: 'winter' },
];

let allPassed = true;
const rows = [];

for (const c of cases) {
  const demand = demandField({ cells, params, ...c });
  for (const s of SEGMENTS) {
    const Ds = segmentDemand(s, c.year, c.scenario, params);
    const m =
      c.dayType === 'weekend'
        ? params.M1_demand.m_weekday_weekend[M_GROUP[s]].value_weekend
        : params.M1_demand.m_weekday_weekend[M_GROUP[s]].value_weekday;
    const zeta = params.M1_demand.zeta_season[c.season].value;
    const expected = Ds * m * zeta;

    let sum = 0;
    const arr = demand[s];
    for (let k = 0; k < arr.length; k++) sum += arr[k];

    const relError = expected !== 0 ? Math.abs(sum - expected) / Math.abs(expected) : Math.abs(sum);
    const pass = relError < 1e-9;
    if (!pass) allPassed = false;
    rows.push({ ...c, segment: s, expected: expected.toFixed(6), sum: sum.toFixed(6), relError: relError.toExponential(3), status: pass ? 'OK' : 'FAIL' });
  }
}

console.table(rows);
console.log(allPassed ? 'Т1: ПРОЙДЕН' : 'Т1: ПРОВАЛЕН');
if (!allPassed) process.exit(1);
