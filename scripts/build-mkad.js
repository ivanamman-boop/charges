// Контур МКАД из OSM -> data/mkad.json. Станции с Яндекс.Карт собирались
// объездом карты только внутри МКАД (пользователь, 23.09), за МКАДом
// (Новая Москва, Коммунарка, приграничные районы) данные о станциях почти
// только из OSM и заведомо неполные. Модель видит там "пустыню без
// конкурентов", и рекомендации модуля 8 уходили туда - это артефакт дыры
// в данных, а не находка. Пул площадок ограничен внутренней частью МКАД.
//
// Контур - выпуклая оболочка всех точек проезжей части МКАД. МКАД почти
// выпуклый, оболочка отличается от реальной линии на сотни метров в
// нескольких местах - для отбора площадок этого достаточно, сшивать
// десятки way-сегментов двух направлений в кольцо не нужно.
//
// Запуск: npm run build:mkad  (--refresh - перезапросить Overpass)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, 'data-sources', 'osm-mkad-points.json');
const OUT_PATH = join(__dirname, '..', 'data', 'mkad.json');

const QUERY = `[out:json][timeout:120];
way["highway"="trunk"]["loc_ref"="МКАД"];
out geom;`;

async function fetchPoints(attempt = 1) {
  if (existsSync(CACHE_PATH) && !process.argv.includes('--refresh')) return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'User-Agent': 'charges-prototype-research/1.0', 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*' },
      body: 'data=' + encodeURIComponent(QUERY),
      signal: AbortSignal.timeout(150000),
    });
    const text = await res.text();
    if (!res.ok || !text.startsWith('{')) throw new Error(`Overpass: HTTP ${res.status}`);
    // В OSM МКАД - highway=trunk (не motorway), loc_ref=МКАД, name вида
    // "МКАД, 4-й километр" (по участкам), поэтому ищем по loc_ref.
    const points = JSON.parse(text).elements.flatMap((e) => (e.geometry || []).map((g) => [Number(g.lat.toFixed(6)), Number(g.lon.toFixed(6))]));
    if (points.length < 100) throw new Error(`слишком мало точек МКАД (${points.length}) - теги в OSM поменялись?`);
    writeFileSync(CACHE_PATH, JSON.stringify(points));
    return points;
  } catch (err) {
    if (attempt >= 5) throw err;
    console.log(`  (${err.message}, жду ${15 * attempt}с, попытка ${attempt + 1})`);
    await new Promise((r) => setTimeout(r, 15000 * attempt));
    return fetchPoints(attempt + 1);
  }
}

// Выпуклая оболочка (монотонная цепочка Эндрю) в координатах [lon, lat].
function convexHull(points) {
  const p = points.map(([lat, lon]) => [lon, lat]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1)).map(([lon, lat]) => [lat, lon]);
}

const points = await fetchPoints();
const ring = convexHull(points);
const lats = points.map((p) => p[0]);
const lons = points.map((p) => p[1]);
writeFileSync(
  OUT_PATH,
  JSON.stringify({
    source: `OpenStreetMap (Overpass API): highway=trunk, loc_ref=МКАД, ${points.length} точек проезжей части → выпуклая оболочка (${ring.length} вершин). Внутри МКАД - зона, где станции собраны полно (OSM + Яндекс.Карты)`,
    date: new Date().toISOString().slice(0, 10),
    ring, // [[lat, lon], ...]
  })
);
console.log(`МКАД: ${points.length} точек → контур из ${ring.length} вершин, lat ${Math.min(...lats)}..${Math.max(...lats)}, lon ${Math.min(...lons)}..${Math.max(...lons)}`);
