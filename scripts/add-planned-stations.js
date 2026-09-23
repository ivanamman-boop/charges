// Раздел 3.1: планируемые городом быстрые станции -> data/stations.json
// (status "planned", year_open 2027-2030). Без них сеть в модели к 2030 не
// растёт, а парк ЭМ растёт ~×14: каждая новая станция к 2030 набирала ~85
// сессий/сутки, NPV рекомендаций модуля 8 был завышен, а требование Acc
// ≥ 90% в 2030 не выполнялось нигде (см. journal.md 23-24.09).
//
// Количество - по плану города (params.planned_network: 500 быстрых точек
// 150 кВт в год, «Энергия Москвы»), доля внутри МКАД - допущение. МЕСТА
// открытым списком не публикуются, поэтому оценка: ячейки сетки выбираются
// с вероятностью, пропорциональной спросу (Σ_s D_s·w_s,i, 2028, base),
// точка - в пределах ячейки, не ближе min_distance_m к действующим и уже
// поставленным плановым. Фиксированный seed - результат воспроизводим.
//
// Последний шаг цепочки данных (после clip:mkad). Идемпотентен: прежние
// плановые станции удаляются перед генерацией.
//
// Запуск: npm run add:planned
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cellWeights, segmentDemand, SEGMENTS } from '../js/demand.js';
import { haversineKm } from '../js/choice.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data');
const read = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));
const params = read('params.json');
const cells = read('cells.json').cells;
const raw = read('stations.json');
const plan = params.planned_network;

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
const rand = mulberry32(plan.seed);

const existing = raw.stations.filter((s) => s.status !== 'planned');
const weights = cellWeights(cells, params);
const demand = cells.map((_, i) => SEGMENTS.reduce((a, s) => a + segmentDemand(s, 2028, 'base', params) * weights[s][i], 0));
const total = demand.reduce((a, b) => a + b, 0);
const cumulative = [];
demand.reduce((acc, v, i) => (cumulative[i] = acc + v / total), 0);
const pickCell = () => {
  const r = rand();
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] < r) lo = mid + 1;
    else hi = mid;
  }
  return cells[lo];
};

const minKm = plan.min_distance_m.value / 1000;
const perYear = Math.round((plan.points_per_year.value / plan.posts_per_station.value) * plan.share_inside_mkad.value);
const placed = [];
const all = [...existing];
for (let year = plan.first_year.value; year <= plan.last_year.value; year++) {
  let n = 0;
  let tries = 0;
  while (n < perYear && tries < perYear * 200) {
    tries++;
    const c = pickCell();
    const lat = c.lat + (rand() - 0.5) * 0.009;
    const lon = c.lon + (rand() - 0.5) * 0.016;
    if (all.some((s) => Math.abs(s.lat - lat) < 0.005 && haversineKm(lat, lon, s.lat, s.lon) < minKm)) continue;
    const st = {
      id: `P-${year}-${String(n + 1).padStart(3, '0')}`,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      operator: 'Энергия Москвы (план, место — оценка)',
      P_kW: plan.P_kW.value,
      posts: plan.posts_per_station.value,
      P_post_kW: plan.P_kW.value,
      status: 'planned',
      year_open: year,
    };
    placed.push(st);
    all.push(st);
    n++;
  }
  console.log(`${year}: +${n} плановых станций`);
}

raw.stations = [...existing, ...placed];
const NOTE = ' | + плановые станции города (scripts/add-planned-stations.js): количество по плану «Энергии Москвы», места — оценка ∝ спросу, status "planned".';
if (!raw.source.includes('плановые станции города')) raw.source += NOTE;
writeFileSync(join(DATA, 'stations.json'), JSON.stringify(raw, null, 2));
console.log(`действующих ${existing.length}, плановых ${placed.length} (по ${perYear}/год внутри МКАД)`);
