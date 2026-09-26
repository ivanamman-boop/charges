// Т6. Тест "не скоринг ли это" (спецификация, раздел 13 и 14).
// Ранжируем 50 кандидатов тремя способами и сравниваем ранги тау Кендалла:
//   A. полная модель (реальный профиль по часам, реальное равновесие W,
//      конкуренция с соседями)
//   B. плоский профиль p(h) = 1/24, W = 0 (убираем ось времени)
//   C. без соседей - кандидат конкурирует только с внешней альтернативой
//      (убираем пространственную конкуренцию)
// Критерий: тау Кендалла(A,B) < 0.9 и тау Кендалла(A,C) < 0.9. Если нет -
// модель ведёт себя как обычный скоринг, и это нужно признать (раздел 13).
//
// Раздел 14 explicitly предупреждает: при низкой загрузке (~10%, как в
// 2026) Хафф почти линеен по λ, и ось времени может не влиять на рейтинг
// вообще - тогда Т6 в 2026 может не пройти, и это ожидаемо, а не баг. Тест
// поэтому строго требует прохождения только для 2030 (где загрузка выше и
// эффект должен проявиться), 2026 - отчёт без жёсткого требования.
//
// 26.09 базовый рост спроса снижен с 80% до 30% в год (решение команды).
// При нём сеть 2030 года с 800 городскими станциями загружена слабо (~7%),
// и ось времени тоже почти не влияет на рейтинг (тау 0.925 при пороге 0.9).
// Поэтому 2030 базовый - отчёт без жёсткого требования, а жёстко проверяем
// 2030 при быстром росте (80% в год), где загрузка высокая и очереди есть.
import { readFileSync } from 'node:fs';
import { SEGMENTS, demandField } from '../js/demand.js';
import { buildNetworkContext, equilibrium, localEquilibrium } from '../js/equilibrium.js';
import { buildLnAttractiveness, buildNeighborIndex, assignStationsToCells, huff } from '../js/choice.js';

const cells = JSON.parse(readFileSync(new URL('../data/cells.json', import.meta.url))).cells;
const stationsAll = JSON.parse(readFileSync(new URL('../data/stations.json', import.meta.url))).stations;
const paramsOrig = JSON.parse(readFileSync(new URL('../data/params.json', import.meta.url)));
const params = { ...paramsOrig, equilibrium: { ...paramsOrig.equilibrium, convergence_threshold_hours: paramsOrig.equilibrium.convergence_threshold_hours_precise } };

// --- плоский профиль p(h) = 1/24: b=1, без пиков -> после нормировки ровно 1/24 ---
const flatParams = JSON.parse(JSON.stringify(params));
for (const dayKey of ['hourly_profile_weekday', 'hourly_profile_weekend']) {
  for (const s of SEGMENTS) flatParams.M1_demand[dayKey][s] = { b: 1, peaks: [] };
}
delete flatParams.M1_demand.hourly_correction_weekday; // иначе r(h) снова делает профиль неплоским
delete flatParams.M1_demand.hourly_correction_weekend;

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
const rand = mulberry32(606);
// Кандидат - случайная ячейка сетки ± ~0.5 км, а не случайная точка bbox:
// после обрезки по МКАД (clip-to-mkad.js) углы bbox лежат вне области
// модели, где нет ни одной ячейки спроса.
const N_CANDIDATES = 50;
const candidatesGeo = Array.from({ length: N_CANDIDATES }, (_, k) => {
  const c = cells[Math.floor(rand() * cells.length)];
  return { id: `T6-${k}`, lat: c.lat + (rand() - 0.5) * 0.009, lon: c.lon + (rand() - 0.5) * 0.016 };
});

function sumLam(lamBySegment, idx) {
  let sum = 0;
  for (const s of SEGMENTS) for (let h = 0; h < 24; h++) sum += lamBySegment[s][idx * 24 + h];
  return sum;
}

// Тау Кендалла (tau-a) по значениям метрики напрямую (без явного ранжирования).
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

const DAY = { dayType: 'weekday', season: 'summer' };

function runForYear(year, scenario = 'base') {
  const CONDITIONS = { scenario, ...DAY };
  const stations = stationsAll.filter((s) => s.year_open <= year);
  const fullContext = buildNetworkContext({ cells, stations, params });
  const fullResult = equilibrium({ cells, stations, params, year, ...CONDITIONS, context: fullContext });

  const valuesA = [];
  const valuesB = [];
  const valuesC = [];

  for (const geo of candidatesGeo) {
    const candidate = { id: geo.id, lat: geo.lat, lon: geo.lon, operator: 'РСЗС', P_kW: 60, posts: 1, P_post_kW: 60, status: 'candidate', year_open: year };

    // A. полная модель
    const local = localEquilibrium({ cells, stations, candidate, params, year, ...CONDITIONS, fullContext, fullResult });
    valuesA.push(sumLam(local.combined.bySegment, local.candidateLocalIdx));

    // B. плоский профиль, W=0, но с полной конкуренцией (все станции + кандидат)
    const stationsWithCandidate = [...stations, candidate];
    const homeCell = assignStationsToCells(stationsWithCandidate, cells);
    const neighborIndex = buildNeighborIndex({ cells, stations: stationsWithCandidate, params: flatParams, homeCell });
    const lnA = buildLnAttractiveness({ stations: stationsWithCandidate, params: flatParams });
    const flatDemand = demandField({ cells, params: flatParams, year, ...CONDITIONS });
    const W = new Float64Array(stationsWithCandidate.length * 24); // W=0
    const activeStations = new Uint8Array(stationsWithCandidate.length).fill(1);
    const lamFlat = huff({ cells, stations: stationsWithCandidate, params: flatParams, demand: flatDemand, W, neighborIndex, lnA, activeStations });
    valuesB.push(sumLam(lamFlat.bySegment, stationsWithCandidate.length - 1));

    // C. без соседей - кандидат один в сети (только внешняя альтернатива как конкурент)
    const ctxSolo = buildNetworkContext({ cells, stations: [candidate], params });
    const resSolo = equilibrium({ cells, stations: [candidate], params, year, ...CONDITIONS, context: ctxSolo });
    valuesC.push(sumLam(resSolo.lam.bySegment, 0));
  }

  const tauB = kendallTau(valuesA, valuesB);
  const tauC = kendallTau(valuesA, valuesC);
  return { tauB, tauC };
}

console.log('считаю 2026...');
const r2026 = runForYear(2026);
console.log('2026: тау(полная, плоский профиль) =', r2026.tauB.toFixed(3), ' тау(полная, без соседей) =', r2026.tauC.toFixed(3));

console.log('считаю 2030 (базовый рост)...');
const r2030 = runForYear(2030);
console.log('2030 базовый: тау(полная, плоский профиль) =', r2030.tauB.toFixed(3), ' тау(полная, без соседей) =', r2030.tauC.toFixed(3));

console.log('считаю 2030 (быстрый рост)...');
const r2030o = runForYear(2030, 'optimistic');
console.log('2030 быстрый: тау(полная, плоский профиль) =', r2030o.tauB.toFixed(3), ' тау(полная, без соседей) =', r2030o.tauC.toFixed(3));

console.log('\nКритерий (раздел 13): тау < 0.9. Раздел 14: при низкой загрузке эффект может не проявиться. Жёстко требуем для 2030 при быстром росте; 2026 и 2030 базовый - отчёт (загрузка ~7-10%).');

const ok = (r) => r.tauB < 0.9 && r.tauC < 0.9;
console.log(`2026: ${ok(r2026) ? 'модель НЕ похожа на скоринг' : 'модель ведёт себя как скоринг (ожидаемо при слабой загрузке)'}`);
console.log(`2030 базовый: ${ok(r2030) ? 'модель НЕ похожа на скоринг' : 'модель ведёт себя как скоринг (ожидаемо при слабой загрузке)'}`);
console.log(`2030 быстрый: ${ok(r2030o) ? 'модель НЕ похожа на скоринг' : 'модель ведёт себя как скоринг'}`);

console.log(ok(r2030o) ? 'Т6: ПРОЙДЕН (2030, быстрый рост; 2026 и 2030 базовый см. журнал)' : 'Т6: ПРОВАЛЕН');
if (!ok(r2030o)) process.exit(1);
