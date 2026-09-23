// Заменяет формулу "расстояние от центра + случайный шум" (см. journal.md,
// аудит "что из воздуха" 23.09) на слои привлекательности cells.json
// (res/work/poi/road/taxi), посчитанные из настоящих данных OpenStreetMap.
//
// Что откуда:
//   res  - взвешенная плотность жилых зданий (building=house/apartments/...)
//   work - взвешенная плотность рабочих/коммерческих зданий (office/retail/
//          industrial/...)
//   poi  - плотность точек притяжения (amenity=*, shop=*) в ячейке
//   road - плотность/класс крупных дорог (motorway..tertiary) в ячейке
//   taxi - ПРОИЗВОДНЫЙ показатель (0.6*poi + 0.4*road), напрямую не
//          измерялся - для такси в OSM нет отдельного слоя спроса, это
//          честная эвристика, а не измерение (см. README)
//
// Первая попытка (landuse=residential/commercial зоны) не годится: такие
// зоны в OSM покрывают только ~30% сетки (советские микрорайоны с чёткой
// зоной, но НЕ историческая застройка, где здания размечены поштучно) -
// центр Москвы получал res≈work≈0, хотя реально плотно жилой и торговый.
// Здания даже одним запросом по всему городу падают по таймауту (HTTP 504)
// - решение: скачать плитками по 8.5x8.5км (scripts/fetch-buildings-
// tiled.js); публичный Overpass после ~25 запросов подряд рвёт
// соединения, недостающие плитки докачиваются --fill-missing (все 36
// собраны 23.09, см. journal.md). У большинства зданий building=yes (общий тег без уточнения,
// частый паттерн для массового импорта в русских городах) - им дан
// пониженный вес в сторону res (в русских городах чаще жилые, чем нет),
// а не 0 и не полный вес наравне с явным house/apartments.
//
// Источники закэшированы в компактном виде в scripts/data-sources/
// osm-{buildings,poi,roads}-moscow-compact.json (сырые ответы Overpass
// весили ~85МБ вместе - обрезаны до только нужных полей сразу после
// скачивания, см. journal.md). Здания собираются отдельным скриптом
// (npm run fetch:buildings -- --refresh, тайлами, см. его комментарии),
// poi/roads - Overpass-запросом прямо здесь (npm run assign:demand-layers
// -- --refresh).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CELLS_PATH = join(__dirname, '..', 'data', 'cells.json');
const BUILDINGS_CACHE = join(__dirname, 'data-sources', 'osm-buildings-moscow-compact.json');
const POI_CACHE = join(__dirname, 'data-sources', 'osm-poi-moscow-compact.json');
const ROADS_CACHE = join(__dirname, 'data-sources', 'osm-roads-moscow-compact.json');

const CENTER = { lat: 55.751, lon: 37.618 };
const KM_PER_DEG_LAT = 111.32;
const KM_PER_DEG_LON = 111.32 * Math.cos((CENTER.lat * Math.PI) / 180);
const GRID_HALF_KM = 25.5;
const CELL_KM = 1;
const N_STEPS = Math.round((2 * GRID_HALF_KM) / CELL_KM); // 51

function cellIndexFor(lat, lon) {
  const xKm = (lon - CENTER.lon) * KM_PER_DEG_LON;
  const yKm = (lat - CENTER.lat) * KM_PER_DEG_LAT;
  const ix = Math.floor((xKm + GRID_HALF_KM) / CELL_KM);
  const iy = Math.floor((yKm + GRID_HALF_KM) / CELL_KM);
  if (ix < 0 || ix >= N_STEPS || iy < 0 || iy >= N_STEPS) return -1;
  return iy * N_STEPS + ix; // должен совпадать с порядком в generate-synthetic-data.js
}

// Нормировка по максимуму ломается на реальных данных: один аномально
// плотный квартал (напр. 935 взвешенных зданий в одной ячейке при медиане
// 45 среди ненулевых) прижимает всё остальное к нулю. Нормируем по 95-му
// перцентилю вместо абсолютного максимума - значения выше просто
// клэмпятся в 1.0 (это и есть смысл перцентиля: "почти все ячейки" против
// "буквально самая плотная ячейка города").
function normalizeByPercentile(raw, percentile = 0.95) {
  const sorted = raw.slice().sort((a, b) => a - b);
  const cap = sorted[Math.floor(sorted.length * percentile)] || 1e-9;
  return raw.map((v) => Math.min(1, v / cap));
}

// Возвращает компактный формат сразу (не сырой Overpass JSON) - экономит
// место в кэше: poi -> [[lat,lon],...], roads -> [{highway,geometry:[[lat,lon],...]},...]
async function fetchOverpassCompact(query, cachePath, label, compactFn) {
  if (existsSync(cachePath) && !process.argv.includes('--refresh')) {
    console.log(`беру закэшированные ${label}:`, cachePath);
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  }
  console.log(`запрашиваю Overpass API (${label})...`);
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'User-Agent': 'charges-prototype-research/1.0', 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*' },
    body: 'data=' + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`Overpass API вернул ${res.status} для ${label}`);
  const json = await res.json();
  const compact = compactFn(json.elements);
  writeFileSync(cachePath, JSON.stringify(compact));
  return compact;
}

// building=* -> вес в сторону res/work. "yes" (без уточнения, ~50% всех
// зданий в выгрузке) - пониженный вес к res, а не 0: в жилых кварталах
// массовый импорт застройки в русских городах чаще всего именно жильё без
// уточнённого подтега, полный вес наравне с house/apartments завысил бы
// точность, которой на самом деле нет.
const RES_BUILDING_WEIGHT = {
  house: 1, apartments: 1, residential: 1, detached: 1, dormitory: 1,
  terrace: 1, semidetached_house: 1, bungalow: 1,
  yes: 0.3,
};
const WORK_BUILDING_WEIGHT = {
  office: 1, retail: 1, commercial: 1, industrial: 1, warehouse: 1,
  public: 0.7, civic: 0.7, government: 0.7, university: 0.7, hospital: 0.7,
  school: 0.5, kindergarten: 0.5,
};

async function main() {
  const cellsRaw = JSON.parse(readFileSync(CELLS_PATH, 'utf8'));
  const cells = cellsRaw.cells;

  if (!existsSync(BUILDINGS_CACHE)) {
    throw new Error(`нет ${BUILDINGS_CACHE} - сначала: npm run fetch:buildings`);
  }
  const buildings = JSON.parse(readFileSync(BUILDINGS_CACHE, 'utf8'));
  console.log('зданий в кэше:', buildings.length);

  const poi = await fetchOverpassCompact(
    `[out:json][timeout:90];area["name"="Москва"]["boundary"="administrative"]["admin_level"="4"]->.msk;(node["amenity"](area.msk);node["shop"](area.msk););out body;`,
    POI_CACHE,
    'poi',
    (elements) => elements.filter((e) => e.type === 'node').map((e) => [Number(e.lat.toFixed(6)), Number(e.lon.toFixed(6))])
  );
  const roads = await fetchOverpassCompact(
    `[out:json][timeout:90];area["name"="Москва"]["boundary"="administrative"]["admin_level"="4"]->.msk;(way["highway"~"motorway|trunk|primary|secondary|tertiary"](area.msk););out geom;`,
    ROADS_CACHE,
    'roads',
    (elements) => elements.map((e) => ({ highway: e.tags?.highway || 'tertiary', geometry: (e.geometry || []).map((p) => [Number(p.lat.toFixed(6)), Number(p.lon.toFixed(6))]) }))
  );

  console.log('считаю res/work (плотность зданий по типам)...');
  const resRaw = new Array(cells.length).fill(0);
  const workRaw = new Array(cells.length).fill(0);
  for (const [lat, lon, building] of buildings) {
    const idx = cellIndexFor(lat, lon);
    if (idx < 0) continue;
    resRaw[idx] += RES_BUILDING_WEIGHT[building] || 0;
    workRaw[idx] += WORK_BUILDING_WEIGHT[building] || 0;
  }
  console.log('считаю poi (плотность точек)...');
  const poiRaw = new Array(cells.length).fill(0);
  for (const [lat, lon] of poi) {
    const idx = cellIndexFor(lat, lon);
    if (idx >= 0) poiRaw[idx]++;
  }

  console.log('считаю road (плотность/класс дорог)...');
  const ROAD_WEIGHT = { motorway: 3, trunk: 3, primary: 2, secondary: 1.5, tertiary: 1 };
  const roadRaw = new Array(cells.length).fill(0);
  for (const w of roads) {
    const weight = ROAD_WEIGHT[w.highway] || 1;
    for (const [lat, lon] of w.geometry) {
      const idx = cellIndexFor(lat, lon);
      if (idx >= 0) roadRaw[idx] += weight;
    }
  }

  const resNorm = normalizeByPercentile(resRaw);
  const workNorm = normalizeByPercentile(workRaw);
  const poiNorm = normalizeByPercentile(poiRaw);
  const roadNorm = normalizeByPercentile(roadRaw);

  for (let i = 0; i < cells.length; i++) {
    cells[i].layers = {
      res: Number(resNorm[i].toFixed(3)),
      work: Number(workNorm[i].toFixed(3)),
      poi: Number(poiNorm[i].toFixed(3)),
      road: Number(roadNorm[i].toFixed(3)),
      taxi: Number((0.6 * poiNorm[i] + 0.4 * roadNorm[i]).toFixed(3)),
    };
  }

  cellsRaw.source = `OpenStreetMap (Overpass API): res/work — взвешенная плотность зданий по типу building=* (${buildings.length} зданий, все 36 плиток города); poi — плотность amenity=*+shop=* (144708 точек); road — плотность/класс дорог motorway..tertiary (37959 сегментов); taxi — ПРОИЗВОДНЫЙ от poi+road (0.6/0.4), прямых данных о такси-спросе нет. Все 4 слоя нормированы по 95-му перцентилю (не по максимуму - один аномально плотный квартал иначе прижимал бы всё остальное к нулю), значения выше клэмпятся в 1.0. Границы округов и сетка станций/центров питания — тоже реальные (см. README). Сама решётка ячеек (1x1км, квадрат вместо формы города) — всё ещё синтетика генератора.`;
  cellsRaw.date = new Date().toISOString().slice(0, 10);

  writeFileSync(CELLS_PATH, JSON.stringify(cellsRaw, null, 2));
  console.log('\ndata/cells.json обновлён,', cells.length, 'ячеек');
}

main();
