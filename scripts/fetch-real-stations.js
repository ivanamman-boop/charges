// Реальные быстрые ЭЗС Москвы из OpenStreetMap (Overpass API,
// amenity=charging_station) вместо синтетической случайной сетки.
//
// Сырые данные закэшированы в scripts/data-sources/
// osm-charging-stations-moscow-raw.json (снято 2026-09-20). Чтобы обновить:
//   npm run fetch:stations -- --refresh
//
// Известное ограничение: OSM даёт 286 станций, краудсорс-покрытие неполное
// (в новостях и агрегаторах вроде 2ГИС по Москве на июль 2026 фигурируют
// цифры на порядок больше - под 1000+). Это лучше, чем случайные точки
// (реальные адреса, реальная сеть "Энергия Москвы" - 97 из 286, прямое
// совпадение с сетью из самой спецификации), но не полная картина. Пока
// не заменит официальных данных от Бори/Сони (transport.mos.ru).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, 'data-sources', 'osm-charging-stations-moscow-raw.json');
const OUTPUT_PATH = join(__dirname, '..', 'data', 'stations.json');

const OVERPASS_QUERY = `
[out:json][timeout:50];
area["name"="Москва"]["boundary"="administrative"]["admin_level"="4"]->.msk;
(
  node["amenity"="charging_station"](area.msk);
);
out body;
`;

async function fetchFromOverpass() {
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'User-Agent': 'charges-prototype-research/1.0', 'Content-Type': 'application/x-www-form-urlencoded' },
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

// Подбор ближайшей конфигурации каталога (раздел 8.1) по мощности OSM-тега.
const CATALOG_TIERS = [
  { max: 70, P_kW: 60, P_post_kW: 60 },
  { max: 130, P_kW: 120, P_post_kW: 60 },
  { max: 200, P_kW: 150, P_post_kW: 150 },
  { max: Infinity, P_kW: 300, P_post_kW: 150 },
];

function parsePowerKW(tags) {
  const raw = tags['socket:type2_combo:output'] || tags['socket:chademo:output'] || tags['socket:type2:output'];
  if (!raw) return null;
  const m = String(raw).match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

// Быстрая (DC) или медленная (AC) - модель про быстрые станции (задание),
// медленные 7-22 кВт уходят в data/stations-slow.json (merge-yandex-stations.js).
const DC_SOCKETS = ['type2_combo', 'chademo', 'gb_dc', 'nacs', 'tesla_supercharger'];
const AC_SOCKETS = ['type2', 'type2_cable', 'type1', 'schuko', 'gb_ac'];
function kindOf(tags, powerKW) {
  if (powerKW) return { kind: powerKW >= 40 ? 'fast' : 'slow', kind_source: 'мощность' };
  if (DC_SOCKETS.some((t) => tags[`socket:${t}`])) return { kind: 'fast', kind_source: 'разъёмы' };
  if (AC_SOCKETS.some((t) => tags[`socket:${t}`])) return { kind: 'slow', kind_source: 'разъёмы' };
  return { kind: 'unknown', kind_source: null };
}

function tierFor(powerKW) {
  const p = powerKW ?? 60; // нет тега мощности -> дефолт 60 (самая частая конфигурация по спецификации)
  return CATALOG_TIERS.find((t) => p <= t.max);
}

function normalizeOperator(tags) {
  return tags.network || tags.operator || tags.brand || 'независимый';
}

async function main() {
  const raw = await loadRaw();
  const nodes = raw.elements.filter((e) => e.type === 'node' && e.lat && e.lon);

  const stations = nodes.map((n, i) => {
    const tags = n.tags || {};
    const powerKW = parsePowerKW(tags);
    const tier = tierFor(powerKW);
    let posts = Number(String(tags.capacity || '').split(';')[0]) || 1;
    posts = Math.max(1, Math.min(4, posts));

    return {
      id: `S-${String(i + 1).padStart(4, '0')}`,
      lat: n.lat,
      lon: n.lon,
      operator: normalizeOperator(tags),
      P_kW: tier.P_kW,
      posts,
      P_post_kW: tier.P_post_kW,
      P_known: powerKW !== null,
      ...kindOf(tags, powerKW),
      status: 'active',
      year_open: 2024, // OSM не даёт дату открытия - консервативное допущение "уже работает"
      osm_id: n.id, // для сверки с источником, не используется расчётом
    };
  });

  writeFileSync(
    OUTPUT_PATH,
    JSON.stringify(
      {
        source: 'OpenStreetMap (Overpass API), amenity=charging_station, area=Москва. Реальные координаты; P_kW/posts подобраны к ближайшей конфигурации каталога 8.1 по тегам мощности/capacity, year_open не в OSM - допущение 2024. Покрытие неполное (286 из ~1000+ по независимым оценкам), заменить на данные Бори/Сони с transport.mos.ru при появлении.',
        date: '2026-09-20',
        stations,
      },
      null,
      2
    )
  );

  console.log(`data/stations.json переписан: ${stations.length} станций из OSM`);
  const byOperator = {};
  for (const s of stations) byOperator[s.operator] = (byOperator[s.operator] || 0) + 1;
  console.log('топ операторов:', Object.entries(byOperator).sort((a, b) => b[1] - a[1]).slice(0, 8));
}

main();
