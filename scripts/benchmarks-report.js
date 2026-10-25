// Место эталонных станций РСЗС (data/benchmarks.json) в сети РСЗС по расчёту
// модели - то же, что показывает слой «Эталоны РСЗС» на сайте (app.js
// benchmarkStats): 2026 год, базовый сценарий, средний день года, сеть -
// станции с метками «РСЗС» и «Энергия Москвы», станции одного адреса - одна
// единица. Модель на эталонах не настраивается, скрипт только сверяет.
// Запуск: npm run report:benchmarks
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildNetworkContext, equilibrium, dailySessions } from '../js/equilibrium.js';
import { stationsActiveIn } from '../js/demand.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const read = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));
const cells = read('cells.json').cells;
const params = read('params.json');
params.equilibrium = { ...params.equilibrium, convergence_threshold_hours: params.equilibrium.convergence_threshold_hours_precise };
const benchmarks = read('benchmarks.json').benchmarks;
const YEAR = 2026;
const OPS = new Set(['РСЗС', 'Энергия Москвы']);

const stations = stationsActiveIn(read('stations.json').stations, YEAR, 'base', params);
const n = stations.length;
const context = buildNetworkContext({ cells, stations, params });
const S = new Float64Array(n);
const U = new Float64Array(n);
for (const [season, ws] of [['winter', 5 / 12], ['summer', 7 / 12]])
  for (const [dayType, wd] of [['weekday', 5 / 7], ['weekend', 2 / 7]]) {
    const r = equilibrium({ cells, stations, params, year: YEAR, scenario: 'base', dayType, season, context });
    const s = dailySessions(r.qh.lambdaSrv, n);
    for (let j = 0; j < n; j++) {
      S[j] += ws * wd * s[j];
      let u = 0;
      for (let h = 0; h < 24; h++) u += r.qh.U[j * 24 + h];
      U[j] += (ws * wd * u) / 24;
    }
  }

// Эталон - точка: станции модели в radius_m от неё (номера S-xxxx меняются).
const kmTo = (b, st) => Math.hypot((b.lat - st.lat) * 111.32, (b.lon - st.lon) * 111.32 * Math.cos((55.75 * Math.PI) / 180));
const groups = new Map(benchmarks.map((b) => [b.id, stations.map((st, j) => (kmTo(b, st) * 1000 <= (b.radius_m ?? 40) ? j : -1)).filter((j) => j >= 0)]));
const inBench = new Set([...groups.values()].flat());
const units = stations.flatMap((st, j) => (OPS.has(st.operator) && !st.outside_mkad && !inBench.has(j) ? [{ S: S[j], U: U[j] }] : []));
const items = benchmarks.map((b) => {
  const js = groups.get(b.id);
  const posts = js.reduce((a, j) => a + stations[j].posts, 0);
  return { ...b, station_ids: js.map((j) => stations[j].id), posts, S: js.reduce((a, j) => a + S[j], 0), U: posts ? js.reduce((a, j) => a + U[j] * stations[j].posts, 0) / posts : 0 };
});
const all = [...units, ...items];
const N = all.length;
const rank = (v, k) => 1 + all.filter((x) => x[k] > v).length;
console.log(`Сеть РСЗС в модели: ${N} единиц (${YEAR}, базовый сценарий, средний день года)`);
console.table(
  items.map((b) => {
    const rU = rank(b.U, 'U');
    return {
      адрес: b.address,
      тип: b.type,
      станции: b.station_ids.join(', '),
      постов: b.posts,
      'сессий/сут': b.S.toFixed(1),
      загрузка: `${(b.U * 100).toFixed(1)}%`,
      'место по сессиям': rank(b.S, 'S'),
      'место по загрузке': rU,
      расхождение: (b.type === 'weak' ? rU <= N / 2 : rU > N / 2) ? 'да' : 'нет',
    };
  })
);
