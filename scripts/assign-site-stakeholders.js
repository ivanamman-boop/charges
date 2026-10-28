// Кто владеет площадкой - для блока «Участники проекта» в паспорте
// (предложение эксперта вуза 28.10: паспорт должен сразу показывать всех
// участников - сетевую компанию, владельца земли/объекта, город).
//
// Для каждой площадки пула (data/pool.json) - обратное геокодирование
// Nominatim (OSM) с extratags: что за объект в точке (парковка, ТЦ, АЗС,
// бизнес-центр, жилой квартал), его название, оператор, платность, доступ.
// Правообладатель (site.owner) выводится правилами js/stakeholders.js ownerOf:
// city / residential / commercial / public / unknown.
// Это подсказка для переговоров, а не юридический факт.
//
// Кэш: data-sources/nominatim-stakeholders-cache.json, 1 запрос в секунду.
//   node scripts/assign-site-stakeholders.js [--offline]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerOf } from '../js/stakeholders.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POOL_PATH = join(ROOT, 'data', 'pool.json');
const CACHE_PATH = join(ROOT, 'scripts', 'data-sources', 'nominatim-stakeholders-cache.json');
const OFFLINE = process.argv.includes('--offline');

const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reverse(lat, lon) {
  const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  if (key in cache) return cache[key];
  if (OFFLINE) return null;
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&extratags=1&namedetails=1&accept-language=ru&lat=${lat}&lon=${lon}`;
  let value = null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'charges-prototype/0.1 (github.com/ivanamman-boop/charges)' } });
    if (res.ok) {
      const j = await res.json();
      const x = j.extratags || {};
      const a = j.address || {};
      value = {
        category: j.category || null,
        type: j.type || null,
        name: j.name || null,
        operator: x.operator || null,
        fee: x.fee || null,
        access: x.access || null,
        parking: x.parking || null,
        residential: a.residential || null,
        landuse: j.category === 'landuse' ? j.type : null,
      };
    }
  } catch {
    value = null;
  }
  await sleep(1100);
  cache[key] = value;
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1));
  return value;
}

const raw = JSON.parse(readFileSync(POOL_PATH, 'utf8'));
let n = 0;
for (const site of raw.pool) {
  const o = await reverse(site.lat, site.lon);
  site.osm_object = o ? { type: o.type, name: o.name, operator: o.operator, fee: o.fee, access: o.access } : null;
  site.owner = ownerOf(o, { kind: site.kind, siteName: site.name });
  if (++n % 50 === 0) console.log(`${n}/${raw.pool.length}`);
}
writeFileSync(POOL_PATH, JSON.stringify(raw, null, 1));
const c = {};
for (const s of raw.pool) c[s.owner.kind] = (c[s.owner.kind] || 0) + 1;
console.log('правообладатель (подсказка):', c);
