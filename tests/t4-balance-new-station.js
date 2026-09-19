// Т4. Баланс при добавлении станции (спецификация, раздел 13, формула 6.2).
// S_new + Σ_{j≠new} ΔS_j = -ΔΛ_out - ΔΛ_lost, невязка < 1e-6 сессии.
import { readFileSync } from 'node:fs';
import {
  buildNetworkContext,
  equilibrium,
  dailySessions,
  lostDemandTotal,
  outsideDemandTotal,
} from '../js/equilibrium.js';

const cells = JSON.parse(readFileSync(new URL('../data/cells.json', import.meta.url))).cells;
const stationsAll = JSON.parse(readFileSync(new URL('../data/stations.json', import.meta.url))).stations;
const params = JSON.parse(readFileSync(new URL('../data/params.json', import.meta.url)));

const YEAR = 2026;
const baseline = stationsAll.filter((s) => s.year_open <= YEAR);

// Кандидат: DC60-2 в центре города (совпадает с центром сетки генератора).
const candidate = {
  id: 'CANDIDATE',
  lat: 55.751,
  lon: 37.618,
  operator: 'РСЗС',
  P_kW: 60,
  posts: 2,
  P_post_kW: 60,
  status: 'candidate',
  year_open: YEAR,
};
const withCandidate = [...baseline, candidate];
const newIdx = withCandidate.length - 1;

const conditions = { year: YEAR, scenario: 'base', dayType: 'weekday', season: 'summer' };

const ctx0 = buildNetworkContext({ cells, stations: baseline, params });
const r0 = equilibrium({ cells, stations: baseline, params, ...conditions, context: ctx0 });

const ctx1 = buildNetworkContext({ cells, stations: withCandidate, params });
const r1 = equilibrium({ cells, stations: withCandidate, params, ...conditions, context: ctx1 });

const S0 = dailySessions(r0.qh.lambdaSrv, baseline.length);
const S1 = dailySessions(r1.qh.lambdaSrv, withCandidate.length);

let sumDeltaS = S1[newIdx]; // S_new
for (let j = 0; j < baseline.length; j++) sumDeltaS += S1[j] - S0[j];

const lambdaOut0 = outsideDemandTotal(r0.lam);
const lambdaOut1 = outsideDemandTotal(r1.lam);
const deltaLambdaOut = lambdaOut1 - lambdaOut0;

const lambdaLost0 = lostDemandTotal(r0.lam, r0.qh.lambdaSrv, baseline.length);
const lambdaLost1 = lostDemandTotal(r1.lam, r1.qh.lambdaSrv, withCandidate.length);
const deltaLambdaLost = lambdaLost1 - lambdaLost0;

const lhs = sumDeltaS;
const rhs = -deltaLambdaOut - deltaLambdaLost;
const residual = Math.abs(lhs - rhs);

console.log('S_new + Σ ΔS_j (LHS):', lhs.toFixed(8));
console.log('-ΔΛout - ΔΛlost (RHS):', rhs.toFixed(8));
console.log('невязка:', residual.toExponential(3));

const pass = residual < 1e-6;
console.log(pass ? 'Т4: ПРОЙДЕН' : 'Т4: ПРОВАЛЕН');
if (!pass) process.exit(1);
