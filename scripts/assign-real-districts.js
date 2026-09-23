// Заменяет грубое секторное деление districtFor() (круг вокруг центра,
// поделённый на 8 кусков - см. journal.md, запись про "дыры в данных")
// на настоящие границы административных округов Москвы из OSM
// (boundary=administrative, admin_level=5 - это ровно уровень
// ЦАО/САО/СВАО/... - районы (admin_level=8) не нужны, у нас в спецификации
// используются только округа).
//
// Источник закэширован в scripts/data-sources/osm-districts-moscow-raw.json.
// Обновить: npm run fetch:districts -- --refresh
//
// Известное ограничение: Overpass вернул 11 из 12 округов запроса - без
// Зеленоградского (ЗелАО, отдельный анклав в ~40км от центра, вне радиуса
// нашей сетки 25.5км в любом случае - см. generate-synthetic-data.js
// GRID_HALF_KM). Для ячеек, не попавших ни в один настоящий полигон
// (пограничные случаи на самом краю сетки), используется ближайший округ
// по центроиду как запасной вариант, а не жёсткая метка - это честнее, чем
// молчаливое "ЗелАО" из старой секторной логики.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, 'data-sources', 'osm-districts-moscow-raw.json');
const CELLS_PATH = join(__dirname, '..', 'data', 'cells.json');

const OVERPASS_QUERY = `
[out:json][timeout:60];
area["name"="Москва"]["boundary"="administrative"]["admin_level"="4"]->.msk;
(
  relation["boundary"="administrative"]["admin_level"="5"](area.msk);
);
out geom;
`;

async function fetchFromOverpass() {
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'User-Agent': 'charges-prototype-research/1.0', 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*' },
    body: 'data=' + encodeURIComponent(OVERPASS_QUERY),
  });
  if (!res.ok) throw new Error(`Overpass API вернул ${res.status}`);
  const json = await res.json();
  writeFileSync(CACHE_PATH, JSON.stringify(json, null, 2));
  return json;
}

function loadRaw() {
  if (existsSync(CACHE_PATH) && !process.argv.includes('--refresh')) {
    console.log('беру закэшированные данные:', CACHE_PATH, '(--refresh для повторного запроса к Overpass)');
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  }
  console.log('запрашиваю Overpass API...');
  return fetchFromOverpass();
}

// Полное название OSM -> короткая аббревиатура, как в спецификации/коде.
const NAME_MAP = {
  'Центральный административный округ': 'ЦАО',
  'Северный административный округ': 'САО',
  'Северо-Восточный административный округ': 'СВАО',
  'Восточный административный округ': 'ВАО',
  'Юго-Восточный административный округ': 'ЮВАО',
  'Южный административный округ': 'ЮАО',
  'Юго-Западный административный округ': 'ЮЗАО',
  'Западный административный округ': 'ЗАО',
  'Северо-Западный административный округ': 'СЗАО',
  'Зеленоградский административный округ': 'ЗелАО',
  'Новомосковский административный округ': 'НАО',
  'Троицкий административный округ': 'ТАО',
};

function ptEq(a, b) {
  return a.lat === b.lat && a.lon === b.lon;
}

// Сшивает разрозненные way-сегменты границы в замкнутые кольца (relation
// boundary=administrative не гарантирует, что members идут по порядку и в
// одном направлении - типичная OSM-специфика).
function stitchRings(ways) {
  const segments = ways.map((w) => w.slice());
  const rings = [];
  while (segments.length) {
    let current = segments.shift();
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const cLast = current[current.length - 1];
        const cFirst = current[0];
        if (ptEq(cLast, seg[0])) {
          current = current.concat(seg.slice(1));
        } else if (ptEq(cLast, seg[seg.length - 1])) {
          current = current.concat(seg.slice(0, -1).reverse());
        } else if (ptEq(cFirst, seg[seg.length - 1])) {
          current = seg.slice(0, -1).concat(current);
        } else if (ptEq(cFirst, seg[0])) {
          current = seg.slice(1).reverse().concat(current);
        } else {
          continue;
        }
        segments.splice(i, 1);
        changed = true;
        break;
      }
    }
    rings.push(current);
  }
  return rings;
}

function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat;
    const xi = ring[i].lon;
    const yj = ring[j].lat;
    const xj = ring[j].lon;
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function ringCentroid(ring) {
  let lat = 0;
  let lon = 0;
  for (const p of ring) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / ring.length, lon: lon / ring.length };
}

function distKm(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dPhi = toRad(b.lat - a.lat);
  const dPsi = toRad(b.lon - a.lon);
  const h = Math.sin(dPhi / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dPsi / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function main() {
  const raw = await loadRaw();
  const districts = raw.elements.map((rel) => {
    const name = rel.tags.name;
    const abbr = NAME_MAP[name] || name;
    const outerWays = rel.members.filter((m) => m.type === 'way' && m.role === 'outer' && m.geometry).map((m) => m.geometry);
    const rings = stitchRings(outerWays);
    return { abbr, rings, centroid: ringCentroid(rings[0] || []) };
  });
  console.log('округов с геометрией:', districts.map((d) => `${d.abbr} (${d.rings.length} колец)`).join(', '));

  const cellsRaw = JSON.parse(readFileSync(CELLS_PATH, 'utf8'));
  let matched = 0;
  let fallback = 0;
  const before = {};
  const after = {};
  for (const cell of cellsRaw.cells) {
    before[cell.district] = (before[cell.district] || 0) + 1;
    let found = null;
    for (const d of districts) {
      if (d.rings.some((ring) => pointInRing(cell.lat, cell.lon, ring))) {
        found = d.abbr;
        break;
      }
    }
    if (!found) {
      // Запасной вариант: ближайший округ по центроиду (честно, а не тихая
      // ошибка) - должно случаться редко, только у самого края сетки.
      let bestD = Infinity;
      for (const d of districts) {
        const dist = distKm(cell, d.centroid);
        if (dist < bestD) {
          bestD = dist;
          found = d.abbr;
        }
      }
      fallback++;
    } else {
      matched++;
    }
    cell.district = found;
    after[found] = (after[found] || 0) + 1;
  }

  writeFileSync(CELLS_PATH, JSON.stringify(cellsRaw, null, 2));

  console.log(`\nячеек всего: ${cellsRaw.cells.length}, попали в реальный полигон: ${matched}, по запасному варианту (ближайший центроид): ${fallback}`);
  console.log('было (секторное деление):', before);
  console.log('стало (настоящие границы):', after);
}

main();
