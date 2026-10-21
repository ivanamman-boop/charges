// Адреса действующих станций (быстрых и медленных) для поиска на сайте.
// В расчёт модели адрес не входит - скрипт только дописывает поля
// address / address_source, координаты и всё остальное не трогает.
//
// Источник по порядку:
//   1. Яндекс.Карты - ближайшая запись из yandex-charging-stations-compact.json
//      не дальше 20 м (так же сопоставляет merge-yandex-stations.js);
//   2. теги addr:* у OSM-точки (osm_id);
//   3. обратное геокодирование Nominatim (OSM) - кэш в
//      data-sources/nominatim-reverse-cache.json, 1 запрос в секунду
//      (правила Nominatim), без сети работает по кэшу.
// Плановые станции (status planned) без адреса: место - оценка модели.
//
// Запускать после всей цепочки станций (merge:yandex, clip:mkad, add:planned) -
// те скрипты пересобирают stations.json и адреса теряются.
//   node scripts/assign-station-addresses.js [--offline]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const SRC = join(ROOT, 'scripts', 'data-sources');
const CACHE_PATH = join(SRC, 'nominatim-reverse-cache.json');
const MATCH_M = 20;
const OFFLINE = process.argv.includes('--offline');

const distM = (a, b) => {
  const dy = (a.lat - b.lat) * 111320;
  const dx = (a.lon - b.lon) * 111320 * Math.cos((55.75 * Math.PI) / 180);
  return Math.hypot(dx, dy);
};

// "Москва, улица Балчуг, 7" -> "улица Балчуг, 7": город у всех один.
const stripCity = (s) => s.replace(/^Москва,\s*/, '').trim();

const yandex = JSON.parse(readFileSync(join(SRC, 'yandex-charging-stations-compact.json'), 'utf8'))
  .items.filter((it) => it.address)
  .map((it) => ({ lat: it.coordinates[1], lon: it.coordinates[0], address: stripCity(it.address) }));

const osmById = new Map(
  JSON.parse(readFileSync(join(SRC, 'osm-charging-stations-moscow-raw.json'), 'utf8')).elements.map((e) => [e.id, e.tags || {}])
);

const osmAddress = (tags) => {
  const street = tags['addr:street'];
  if (!street) return null;
  return tags['addr:housenumber'] ? `${street}, ${tags['addr:housenumber']}` : street;
};

const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nominatim(st) {
  const key = `${st.lat.toFixed(6)},${st.lon.toFixed(6)}`;
  if (key in cache) return cache[key];
  if (OFFLINE) return null;
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=ru&lat=${st.lat}&lon=${st.lon}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'charges-prototype/0.1 (github.com/ivanamman-boop/charges)' } });
  await sleep(1100);
  if (!res.ok) return null;
  const a = (await res.json()).address || {};
  const street = a.road || a.pedestrian || a.footway || a.square || a.neighbourhood || a.suburb;
  const addr = street ? (a.house_number ? `${street}, ${a.house_number}` : street) : null;
  cache[key] = addr;
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1));
  return addr;
}

for (const file of ['stations.json', 'stations-slow.json']) {
  const raw = JSON.parse(readFileSync(join(DATA, file), 'utf8'));
  const count = { yandex: 0, osm: 0, nominatim: 0, none: 0 };
  for (const st of raw.stations) {
    if (st.status === 'planned') continue;
    let address = null;
    let source = null;
    let best = null;
    for (const y of yandex) {
      const d = distM(st, y);
      if (d <= MATCH_M && (!best || d < best.d)) best = { d, address: y.address };
    }
    // У части записей Яндекса вместо улицы только округ и район
    // ("Восточный административный округ, район Измайлово") - по такому
    // адресу станцию не найти, берём улицу из OSM ниже.
    if (best && !/административный округ/.test(best.address)) [address, source] = [best.address, 'yandex'];
    if (!address && st.osm_id) {
      address = osmAddress(osmById.get(st.osm_id) || {});
      if (address) source = 'osm';
    }
    if (!address) {
      address = await nominatim(st);
      if (address) source = 'nominatim';
    }
    if (address) {
      st.address = address;
      st.address_source = source;
      count[source]++;
    } else {
      delete st.address;
      delete st.address_source;
      count.none++;
    }
  }
  writeFileSync(join(DATA, file), JSON.stringify(raw, null, 2));
  console.log(file, count);
}
