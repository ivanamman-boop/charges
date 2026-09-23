// Генератор синтетических cells.json / stations.json / centers.json
// в формате спецификации (раздел 2). Значения — не реальные данные, только
// заглушки нужной формы и разумного порядка величин, чтобы можно было
// разрабатывать demand.js/choice.js/queue.js/equilibrium.js, не дожидаясь
// настоящих файлов от Бори и Сони (задача на вторник).
//
// Запуск: node scripts/generate-synthetic-data.js
//
// По умолчанию пишет ТОЛЬКО решётку cells.json (слои и округа в ней -
// заглушки, после генератора: assign:districts + assign:demand-layers).
// stations.json и centers.json давно реальные (OSM + Яндекс.Карты) - их
// синтетические версии пишутся только с явным флагом --all, иначе один
// случайный запуск молча затирал 984 реальные станции и 227 подстанций.
// q (ближайший центр питания) считается по реальному data/centers.json,
// если он есть, а не по синтетическим 48 точкам (раньше q указывал на
// случайную подстанцию в среднем в 21км от ячейки, см. journal.md 23.09).

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

// Детерминированный ГПСЧ (mulberry32), чтобы генерация была воспроизводимой.
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
const rand = mulberry32(20260919);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const uniform = (min, max) => min + rand() * (max - min);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// --- геометрия: центр Москвы и km/градус на её широте ---
const CENTER = { lat: 55.751, lon: 37.618 };
const KM_PER_DEG_LAT = 111.32;
const KM_PER_DEG_LON = 111.32 * Math.cos((CENTER.lat * Math.PI) / 180);

const GRID_HALF_KM = 25.5; // даёт сетку ~51x51 = 2601 ячейка, как в спецификации (~2600)
const CELL_KM = 1;

function kmToLat(km) {
  return km / KM_PER_DEG_LAT;
}
function kmToLon(km) {
  return km / KM_PER_DEG_LON;
}
function distKm(a, b) {
  const dLat = (a.lat - b.lat) * KM_PER_DEG_LAT;
  const dLon = (a.lon - b.lon) * KM_PER_DEG_LON;
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

const DISTRICTS = ['ЦАО', 'САО', 'СВАО', 'ВАО', 'ЮВАО', 'ЮАО', 'ЮЗАО', 'ЗАО', 'СЗАО', 'ЗелАО', 'НАО', 'ТАО'];

function districtFor(lat, lon) {
  // Грубое деление на секторы вокруг центра — только для правдоподобной
  // синтетики, не географическая точность.
  const angle = Math.atan2(lat - CENTER.lat, lon - CENTER.lon);
  const idx = Math.floor(((angle + Math.PI) / (2 * Math.PI)) * 8) % 8;
  const sectorDistricts = ['ВАО', 'ЮВАО', 'ЮАО', 'ЮЗАО', 'ЗАО', 'СЗАО', 'САО', 'СВАО'];
  const d = distKm({ lat, lon }, CENTER);
  if (d < 3) return 'ЦАО';
  if (d > 20 && lat < CENTER.lat) return rand() < 0.5 ? 'НАО' : 'ТАО';
  if (d > 18) return 'ЗелАО';
  return sectorDistricts[idx];
}

// --- 1. centers.json: питающие центры (ПС 35-220 кВ) ---
const N_CENTERS = 48;
const centers = [];
for (let i = 0; i < N_CENTERS; i++) {
  const dKm = uniform(0, GRID_HALF_KM * 0.95);
  const angle = uniform(0, 2 * Math.PI);
  const lat = CENTER.lat + kmToLat(dKm * Math.cos(angle));
  const lon = CENTER.lon + kmToLon(dKm * Math.sin(angle));
  centers.push({
    id: `PS-${100 + i}`,
    lat: Number(lat.toFixed(5)),
    lon: Number(lon.toFixed(5)),
    reserve_MVA: Number(uniform(0.5, 12).toFixed(2)),
    bus_planned_kW: rand() < 0.15 ? Math.round(uniform(150, 600) / 10) * 10 : 0,
    reserve_date: '2026-09-01',
  });
}

const WRITE_ALL = process.argv.includes('--all');
const REAL_CENTERS_PATH = join(DATA_DIR, 'centers.json');
const centersForQ =
  !WRITE_ALL && existsSync(REAL_CENTERS_PATH)
    ? JSON.parse(readFileSync(REAL_CENTERS_PATH, 'utf8')).centers
    : centers;

function nearestCenter(lat, lon) {
  let best = null;
  let bestD = Infinity;
  for (const c of centersForQ) {
    const d = distKm({ lat, lon }, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best.id;
}

// --- 2. cells.json: сетка спроса 1x1 км ---
const cells = [];
let cellId = 1;
const nSteps = Math.round((2 * GRID_HALF_KM) / CELL_KM);
for (let iy = 0; iy < nSteps; iy++) {
  for (let ix = 0; ix < nSteps; ix++) {
    const xKm = -GRID_HALF_KM + (ix + 0.5) * CELL_KM;
    const yKm = -GRID_HALF_KM + (iy + 0.5) * CELL_KM;
    const lat = CENTER.lat + kmToLat(yKm);
    const lon = CENTER.lon + kmToLon(xKm);
    const d = Math.sqrt(xKm * xKm + yKm * yKm);

    // Синтетические слои: спад с расстоянием от центра + шум, у каждого
    // слоя свой профиль, чтобы карта не была однородной кашей.
    const centrality = clamp01(1 - d / (GRID_HALF_KM * 0.9));
    const noise = () => uniform(-0.15, 0.15);

    const work = clamp01(centrality * 0.9 + noise());
    const poi = clamp01(Math.pow(centrality, 1.5) * 0.95 + noise());
    const res = clamp01(0.3 + (1 - centrality) * 0.6 + noise());
    const road = clamp01(0.5 + 0.3 * Math.sin(xKm / 3) * Math.sin(yKm / 3) + noise() * 0.5);
    const taxi = clamp01(centrality * 0.7 + (d > GRID_HALF_KM * 0.85 ? 0.4 : 0) + noise() * 0.5);

    cells.push({
      id: cellId++,
      lat: Number(lat.toFixed(5)),
      lon: Number(lon.toFixed(5)),
      district: districtFor(lat, lon),
      layers: {
        res: Number(res.toFixed(3)),
        work: Number(work.toFixed(3)),
        poi: Number(poi.toFixed(3)),
        road: Number(road.toFixed(3)),
        taxi: Number(taxi.toFixed(3)),
      },
      q: nearestCenter(lat, lon),
      dist04_m: null,
    });
  }
}

// Нормировка слоёв на максимум по городу (0-1), как требует раздел 2.
for (const layer of ['res', 'work', 'poi', 'road', 'taxi']) {
  let max = 0;
  for (const c of cells) max = Math.max(max, c.layers[layer]);
  if (max > 0) for (const c of cells) c.layers[layer] = Number((c.layers[layer] / max).toFixed(3));
}

// --- 3. stations.json: действующие + несколько плановых для проверки фильтра year_open ---
const OPERATORS = ['РСЗС', 'Яндекс Заправки', 'СитиЭнерго', 'Атомэнергосбыт', 'независимый'];
// Реальные конфигурации из каталога (раздел 8.1) — P_post не равен P_cap/posts.
const CATALOG_POWERS = [
  { P_cap: 60, posts: 1, P_post: 60, weight: 6 }, // как большинство станций РСЗС (89 из 126)
  { P_cap: 60, posts: 2, P_post: 60, weight: 2 },
  { P_cap: 150, posts: 2, P_post: 150, weight: 2 },
  { P_cap: 300, posts: 4, P_post: 150, weight: 1 },
];
function weightedPick(items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rand() * total;
  for (const it of items) {
    if (r < it.weight) return it;
    r -= it.weight;
  }
  return items[items.length - 1];
}

const N_ACTIVE = 342; // действующие быстрые станции (transport.mos.ru)
const N_PLANNED = 24; // выборка плановых, для проверки year_open <= y (3.1)
const stations = [];
let stationId = 1;
function randomPointInBbox() {
  const xKm = uniform(-GRID_HALF_KM, GRID_HALF_KM);
  const yKm = uniform(-GRID_HALF_KM, GRID_HALF_KM);
  return {
    lat: Number((CENTER.lat + kmToLat(yKm)).toFixed(5)),
    lon: Number((CENTER.lon + kmToLon(xKm)).toFixed(5)),
  };
}

for (let i = 0; i < N_ACTIVE + N_PLANNED; i++) {
  const isPlanned = i >= N_ACTIVE;
  const { lat, lon } = randomPointInBbox();
  const cfg = weightedPick(CATALOG_POWERS);
  stations.push({
    id: `S-${String(stationId++).padStart(4, '0')}`,
    lat,
    lon,
    operator: isPlanned ? 'город' : pick(OPERATORS),
    P_kW: cfg.P_cap,
    posts: cfg.posts,
    P_post_kW: cfg.P_post,
    status: isPlanned ? 'planned' : 'active',
    year_open: isPlanned ? Math.round(uniform(2026, 2028)) : Math.round(uniform(2020, 2026)),
  });
}

// --- запись файлов ---
const today = '2026-09-19';

writeFileSync(
  join(DATA_DIR, 'cells.json'),
  JSON.stringify({ source: 'синтетика (генератор), заменить на OSM + mos.ru', date: today, cells }, null, 2)
);
if (WRITE_ALL) {
writeFileSync(
  join(DATA_DIR, 'stations.json'),
  JSON.stringify(
    { source: 'синтетика (генератор), заменить на transport.mos.ru + atomen.ru + OSM', date: today, stations },
    null,
    2
  )
);
writeFileSync(
  join(DATA_DIR, 'centers.json'),
  JSON.stringify({ source: 'синтетика (генератор), заменить на карту Россети МР', date: today, centers }, null, 2)
);
console.log(`cells: ${cells.length}, stations: ${stations.length} (active ${N_ACTIVE} + planned ${N_PLANNED}), centers: ${centers.length}`);
} else {
  console.log(`cells: ${cells.length} (q по ${centersForQ.length} реальным центрам); stations/centers не тронуты (--all чтобы перезаписать синтетикой)`);
  console.log('дальше: npm run assign:districts && npm run assign:demand-layers');
}
