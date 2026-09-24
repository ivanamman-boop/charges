// Модуль 8, раздел 10.1: пул кандидатов для портфеля. Реальные объекты
// OSM, где физически можно поставить быструю станцию: парковки (кроме
// частных), ТЦ, АЗС, офисные здания/бизнес-центры, гостиницы. Исключаем
// точки ближе 150 м к действующим станциям, отбираем 300 случайно с
// фиксированным seed и стратификацией по округам (пропорционально числу
// объектов в округе). data/pool.json одинаков для обеих стратегий.
// Только внутри МКАД (data/mkad.json): за МКАДом станции собраны неполно,
// модель считается для Москвы внутри МКАД (см. scripts/clip-to-mkad.js).
//
// Запуск: npm run build:pool   (--refresh - перезапросить Overpass)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { haversineKm } from '../js/choice.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, 'data-sources', 'osm-pool-objects-moscow-compact.json');
const DATA = join(__dirname, '..', 'data');

const QUERY = `
[out:json][timeout:180];
area["name"="Москва"]["boundary"="administrative"]["admin_level"="4"]->.msk;
(
  nwr["amenity"="parking"]["access"!~"private|no|customers_only"](area.msk);
  nwr["shop"="mall"](area.msk);
  nwr["amenity"="fuel"](area.msk);
  nwr["building"="office"](area.msk);
  nwr["office"="company"]["building"](area.msk);
  nwr["tourism"="hotel"](area.msk);
);
out center tags;`;

function kindOf(tags) {
  if (tags.shop === 'mall') return 'ТЦ';
  if (tags.amenity === 'fuel') return 'АЗС';
  if (tags.tourism === 'hotel') return 'гостиница';
  if (tags.building === 'office' || tags.office) return 'бизнес-центр';
  return 'парковка';
}

async function fetchObjects(attempt = 1) {
  if (existsSync(CACHE_PATH) && !process.argv.includes('--refresh')) {
    console.log('беру закэшированные объекты:', CACHE_PATH);
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  }
  let json;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'User-Agent': 'charges-prototype-research/1.0', 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*' },
      body: 'data=' + encodeURIComponent(QUERY),
      signal: AbortSignal.timeout(240000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.startsWith('{')) throw new Error('Overpass вернул не JSON (перегружен)');
    json = JSON.parse(text);
  } catch (err) {
    if (attempt >= 6) throw err;
    console.log(`  (${err.message}, жду ${20 * attempt}с, попытка ${attempt + 1})`);
    await new Promise((r) => setTimeout(r, 20000 * attempt));
    return fetchObjects(attempt + 1);
  }
  // Компактно: [lat, lon, вид, название]
  const objects = json.elements
    .map((e) => [e.center?.lat ?? e.lat, e.center?.lon ?? e.lon, kindOf(e.tags || {}), e.tags?.name || null])
    .filter((o) => typeof o[0] === 'number')
    .map((o) => [Number(o[0].toFixed(6)), Number(o[1].toFixed(6)), o[2], o[3]]);
  writeFileSync(CACHE_PATH, JSON.stringify({ source: 'OpenStreetMap (Overpass API), area=Москва: amenity=parking (не частные), shop=mall, amenity=fuel, building=office / office=company, tourism=hotel', date: new Date().toISOString().slice(0, 10), objects }));
  return { objects };
}

async function main() {
  const { objects } = await fetchObjects();
  const params = JSON.parse(readFileSync(join(DATA, 'params.json'), 'utf8'));
  const m8 = params.M8_portfolio;
  const POOL_SIZE = m8.pool_size_max.value;
  const MIN_TO_EXISTING_KM = m8.min_distance_to_existing_m.value / 1000;
  // Только действующие: у плановых (add-planned-stations.js) место - оценка.
  const stations = JSON.parse(readFileSync(join(DATA, 'stations.json'), 'utf8')).stations.filter((s) => s.status !== 'planned');
  const ring = JSON.parse(readFileSync(join(DATA, 'mkad.json'), 'utf8')).ring;
  const insideMkad = (lat, lon) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ai, bi] = ring[i];
      const [aj, bj] = ring[j];
      if (ai > lat !== aj > lat && lon < ((bj - bi) * (lat - ai)) / (aj - ai) + bi) inside = !inside;
    }
    return inside;
  };
  const cells = JSON.parse(readFileSync(join(DATA, 'cells.json'), 'utf8')).cells;

  // Округ - по ближайшей ячейке (у ячеек округ из реальных границ OSM).
  const districtOf = (lat, lon) => {
    let best = null;
    let bestD = Infinity;
    for (const c of cells) {
      const d = (c.lat - lat) ** 2 + ((c.lon - lon) * 0.56) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c.district;
      }
    }
    return best;
  };

  // Сетка 0.01° для быстрого поиска ближайшей станции.
  const grid = new Map();
  const key = (lat, lon) => `${Math.floor(lat * 100)},${Math.floor(lon * 100)}`;
  for (const s of stations) {
    const k = key(s.lat, s.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(s);
  }
  const nearExisting = (lat, lon) => {
    const bi = Math.floor(lat * 100);
    const bj = Math.floor(lon * 100);
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++)
        for (const s of grid.get(`${bi + di},${bj + dj}`) || []) if (haversineKm(lat, lon, s.lat, s.lon) < MIN_TO_EXISTING_KM) return true;
    return false;
  };

  // Дубли (один объект как node + way, соседние въезды одной парковки) -
  // схлопываем в пределах ~50 м, иначе один крупный ТЦ занимал бы пул.
  const seen = new Set();
  const eligible = [];
  for (const [lat, lon, kind, name] of objects) {
    const k = `${Math.round(lat * 2000)},${Math.round(lon * 1100)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!insideMkad(lat, lon) || nearExisting(lat, lon)) continue;
    eligible.push({ lat, lon, kind, name });
  }
  console.log(`объектов OSM: ${objects.length}, внутри МКАД, после дедупликации и фильтра 150 м от станций: ${eligible.length}`);

  const byDistrict = new Map();
  for (const o of eligible) {
    o.district = districtOf(o.lat, o.lon);
    if (!byDistrict.has(o.district)) byDistrict.set(o.district, []);
    byDistrict.get(o.district).push(o);
  }

  // Стабильный отбор: порядок внутри округа задаёт хэш координат самой
  // площадки (с фиксированной солью), а не перетасовка всего списка. Раньше
  // любое изменение станций (новый объезд Яндекса) сдвигало перетасовку, и
  // пул менялся почти целиком - проверенные вручную точки "убегали". Теперь
  // площадка остаётся в пуле, пока она подходит (не ближе 150 м к станции).
  const hashUnit = (lat, lon) => {
    let h = 2166136261;
    for (const ch of `20260924|${lat.toFixed(6)}|${lon.toFixed(6)}`) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
    return (h >>> 0) / 4294967296;
  };
  const pool = [];
  for (const [district, list] of [...byDistrict].sort()) {
    const quota = Math.max(1, Math.round((POOL_SIZE * list.length) / eligible.length));
    const shuffled = [...list].sort((a, b) => hashUnit(a.lat, a.lon) - hashUnit(b.lat, b.lon));
    pool.push(...shuffled.slice(0, quota));
    console.log(`  ${district}: ${list.length} объектов → ${Math.min(quota, list.length)} в пул`);
  }
  pool.length = Math.min(pool.length, POOL_SIZE);
  pool.forEach((p, i) => (p.id = `L-${String(i + 1).padStart(3, '0')}`));

  const kinds = {};
  for (const p of pool) kinds[p.kind] = (kinds[p.kind] || 0) + 1;
  writeFileSync(
    join(DATA, 'pool.json'),
    JSON.stringify(
      {
        source: `Раздел 10.1: ${pool.length} площадок из ${eligible.length} реальных объектов OSM внутри МКАД (парковки, ТЦ, АЗС, бизнес-центры, гостиницы), не ближе ${m8.min_distance_to_existing_m.value} м к действующим станциям, стабильный отбор по хэшу координат (соль 20260924) со стратификацией по округам`,
        date: new Date().toISOString().slice(0, 10),
        pool,
      },
      null,
      1
    )
  );
  console.log(`\nпул: ${pool.length} площадок`, kinds);
}

main();
