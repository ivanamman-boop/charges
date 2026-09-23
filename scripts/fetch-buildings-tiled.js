// Здания Москвы (building=*) по всему городу одним Overpass-запросом
// падают по таймауту (проверено 23.09, HTTP 504 даже на out count) -
// слишком много данных для одного запроса. Решение - разбить сетку
// 51x51км на плитки и запросить каждую отдельно (один bbox 10x15км
// вернул 26003 здания за 2.5с - работает нормально).
//
// Даёт лёгкие точки (центр каждого здания + тип building=*) вместо полной
// геометрии - для подсчёта плотности по ячейкам 1x1км этого достаточно,
// не нужен point-in-polygon.
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, 'data-sources', 'osm-buildings-moscow-compact.json');

const CENTER = { lat: 55.751, lon: 37.618 };
const KM_PER_DEG_LAT = 111.32;
const KM_PER_DEG_LON = 111.32 * Math.cos((CENTER.lat * Math.PI) / 180);
const GRID_HALF_KM = 25.5;
const TILE_KM = 8.5; // 6x6 = 36 плиток, каждая ~ размера успешного теста

function kmToLat(km) {
  return km / KM_PER_DEG_LAT;
}
function kmToLon(km) {
  return km / KM_PER_DEG_LON;
}

async function fetchTile(minLat, minLon, maxLat, maxLon, attempt = 1) {
  const query = `[out:json][timeout:60];(way["building"](${minLat},${minLon},${maxLat},${maxLon}););out center tags;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'User-Agent': 'charges-prototype-research/1.0', 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*' },
    body: 'data=' + encodeURIComponent(query),
  });
  if (res.status === 429 || res.status === 504) {
    if (attempt >= 4) throw new Error(`Overpass вернул ${res.status} (после ${attempt} попыток)`);
    const waitMs = 5000 * attempt; // нарастающая пауза: 5с, 10с, 15с
    console.log(`  (${res.status}, жду ${waitMs / 1000}с и пробую снова, попытка ${attempt + 1})`);
    await new Promise((r) => setTimeout(r, waitMs));
    return fetchTile(minLat, minLon, maxLat, maxLon, attempt + 1);
  }
  if (!res.ok) throw new Error(`Overpass вернул ${res.status}`);
  const json = await res.json();
  // Компактный формат сразу - [lat, lon, building], не {lat, lon, building}:
  // экономит ~40% места (без повторения имён ключей на 250К+ записей),
  // читает assign-real-demand-layers.js.
  return json.elements.map((e) => [Number((e.center?.lat ?? e.lat).toFixed(6)), Number((e.center?.lon ?? e.lon).toFixed(6)), e.tags?.building || 'yes']);
}

async function main() {
  if (existsSync(OUT_PATH) && !process.argv.includes('--refresh')) {
    console.log('уже есть закэшированный файл:', OUT_PATH, '(--refresh для повтора)');
    return;
  }

  const nTiles = Math.ceil((2 * GRID_HALF_KM) / TILE_KM);
  const all = [];
  let tileNum = 0;
  for (let iy = 0; iy < nTiles; iy++) {
    for (let ix = 0; ix < nTiles; ix++) {
      tileNum++;
      const yMinKm = -GRID_HALF_KM + iy * TILE_KM;
      const yMaxKm = Math.min(GRID_HALF_KM, yMinKm + TILE_KM);
      const xMinKm = -GRID_HALF_KM + ix * TILE_KM;
      const xMaxKm = Math.min(GRID_HALF_KM, xMinKm + TILE_KM);
      const minLat = CENTER.lat + kmToLat(yMinKm);
      const maxLat = CENTER.lat + kmToLat(yMaxKm);
      const minLon = CENTER.lon + kmToLon(xMinKm);
      const maxLon = CENTER.lon + kmToLon(xMaxKm);
      try {
        const buildings = await fetchTile(minLat, minLon, maxLat, maxLon);
        all.push(...buildings);
        console.log(`плитка ${tileNum}/${nTiles * nTiles}: ${buildings.length} зданий (всего накоплено ${all.length})`);
      } catch (err) {
        console.log(`плитка ${tileNum}/${nTiles * nTiles}: ОШИБКА ${err.message} - пропускаю`);
      }
      // Пауза между плитками, чтобы не словить 429 (rate limit) на публичном
      // Overpass - 300мс оказалось мало, начал ловить 429 после ~7 плиток.
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  writeFileSync(OUT_PATH, JSON.stringify(all));
  console.log(`\nитого зданий: ${all.length}, записано в ${OUT_PATH}`);
}

main();
