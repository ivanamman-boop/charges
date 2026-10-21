// Адрес и район площадок пула (data/pool.json) - для списка кандидатов и
// паспорта на сайте («Хамовники, Фрунзенская наб., 30»). В расчёт не входит.
// Обратное геокодирование Nominatim (OSM), 1 запрос в секунду, кэш в
// data-sources/nominatim-pool-cache.json - без сети работает по кэшу.
//   node scripts/assign-pool-addresses.js [--offline]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POOL_PATH = join(ROOT, 'data', 'pool.json');
const CACHE_PATH = join(ROOT, 'scripts', 'data-sources', 'nominatim-pool-cache.json');
const OFFLINE = process.argv.includes('--offline');

const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "район Хорошёво-Мнёвники" -> "Хорошёво-Мнёвники"; поселения и округа - как есть.
const cleanArea = (s) => (s ? s.replace(/^(район|поселение|муниципальный округ)\s+/i, '').trim() : null);

async function reverse(lat, lon) {
  const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  if (key in cache) return cache[key];
  if (OFFLINE) return null;
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=ru&lat=${lat}&lon=${lon}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'charges-prototype/0.1 (github.com/ivanamman-boop/charges)' } });
  await sleep(1100);
  if (!res.ok) return null;
  const a = (await res.json()).address || {};
  const street = a.road || a.pedestrian || a.footway || a.square || null;
  const value = {
    address: street ? (a.house_number ? `${street}, ${a.house_number}` : street) : null,
    area: cleanArea(a.suburb || a.city_district || a.quarter || null),
  };
  cache[key] = value;
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1));
  return value;
}

const raw = JSON.parse(readFileSync(POOL_PATH, 'utf8'));
let n = 0;
for (const site of raw.pool) {
  const r = await reverse(site.lat, site.lon);
  if (r?.address) site.address = r.address;
  else delete site.address;
  if (r?.area) site.area = r.area;
  else delete site.area;
  if (++n % 50 === 0) console.log(`${n}/${raw.pool.length}`);
}
writeFileSync(POOL_PATH, JSON.stringify(raw, null, 1));
console.log(`адрес у ${raw.pool.filter((s) => s.address).length}, район у ${raw.pool.filter((s) => s.area).length} из ${raw.pool.length}`);
