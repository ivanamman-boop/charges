// Обогащает data/stations.json (сгенерированный из OSM скриптом
// fetch-real-stations.js) реальными данными Яндекс.Карт: точные координаты,
// оператор, мощность и число разъёмов - там, где они у нас есть.
//
// Источник - scripts/data-sources/yandex-charging-stations-compact.json:
// вручную собранные пользователем ответы поиска "Электрозаправки" на
// yandex.ru/maps (вкладка Network в DevTools - отдельные XHR-ответы и один
// экспорт HAR после объезда карты), сведённые в один компактный файл (см.
// docs/journal.md, запись про сбор реальных станций 20.09).
//
// Запускать ПОСЛЕ fetch-real-stations.js (тот пересоздаёт stations.json
// с нуля из OSM - этот скрипт довносит поверх).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPACT_PATH = join(__dirname, 'data-sources', 'yandex-charging-stations-compact.json');
const STATIONS_PATH = join(__dirname, '..', 'data', 'stations.json');

const CATALOG_TIERS = [
  { max: 70, P_kW: 60, P_post_kW: 60 },
  { max: 130, P_kW: 120, P_post_kW: 60 },
  { max: 200, P_kW: 150, P_post_kW: 150 },
  { max: Infinity, P_kW: 300, P_post_kW: 150 },
];
function tierFor(powerKW) {
  const p = powerKW ?? 60;
  return CATALOG_TIERS.find((t) => p <= t.max);
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dPhi = toRad(bLat - aLat);
  const dPsi = toRad(bLon - aLon);
  const h = Math.sin(dPhi / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dPsi / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function parseCompactItem(item) {
  const [lon, lat] = item.coordinates || [];
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;

  const features = item.features || [];
  const powerFeature = features.find((f) => f.id === 'charging_station_power');
  const connFeature = features.find((f) => f.id === 'number_of_connectors');

  let powerKW = null;
  if (powerFeature?.value) {
    const nums = String(powerFeature.value).match(/\d+(?:[.,]\d+)?/g);
    if (nums) powerKW = Math.max(...nums.map((n) => Number(n.replace(',', '.'))));
  }
  let posts = connFeature?.value ? Number(String(connFeature.value).match(/\d+/)?.[0]) : null;
  if (!posts || posts < 1) posts = 1;
  posts = Math.min(4, posts);

  const tier = tierFor(powerKW);
  const operator = item.chainName || item.title || 'независимый';

  return { lat, lon, operator, P_kW: tier.P_kW, posts, P_post_kW: tier.P_post_kW, status: 'active', year_open: 2024 };
}

function loadYandexCandidates() {
  const compact = JSON.parse(readFileSync(COMPACT_PATH, 'utf8'));
  const candidates = compact.items.map(parseCompactItem).filter(Boolean);
  console.log(`  ${compact.items.length} записей в компактном файле (${compact.date}), ${candidates.length} с валидными координатами`);
  return candidates;
}

function main() {
  const base = JSON.parse(readFileSync(STATIONS_PATH, 'utf8'));
  const stations = base.stations;
  console.log('базовых станций (OSM):', stations.length);

  const yandexCandidates = loadYandexCandidates();

  const MATCH_RADIUS_KM = 0.05; // 50 м - считаем той же станцией
  let replaced = 0;
  let added = 0;

  for (const cand of yandexCandidates) {
    let nearestIdx = -1;
    let nearestDist = Infinity;
    for (let i = 0; i < stations.length; i++) {
      const d = haversineKm(cand.lat, cand.lon, stations[i].lat, stations[i].lon);
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = i;
      }
    }
    if (nearestIdx >= 0 && nearestDist <= MATCH_RADIUS_KM) {
      const id = stations[nearestIdx].id;
      stations[nearestIdx] = { id, lat: cand.lat, lon: cand.lon, operator: cand.operator, P_kW: cand.P_kW, posts: cand.posts, P_post_kW: cand.P_post_kW, status: cand.status, year_open: cand.year_open, source_detail: 'yandex' };
      replaced++;
    } else {
      stations.push({ id: `S-${String(stations.length + 1).padStart(4, '0')}`, lat: cand.lat, lon: cand.lon, operator: cand.operator, P_kW: cand.P_kW, posts: cand.posts, P_post_kW: cand.P_post_kW, status: cand.status, year_open: cand.year_open, source_detail: 'yandex' });
      added++;
    }
  }

  writeFileSync(
    STATIONS_PATH,
    JSON.stringify(
      {
        source: `OpenStreetMap (Overpass API, ${stations.length - added - replaced} только-OSM) + Яндекс.Карты (вручную собранные ответы поиска "Электрозаправки" из DevTools, см. scripts/data-sources/yandex-charging-stations-compact.json: ${replaced} уточнили существующие OSM-точки точной мощностью/оператором, ${added} добавили новых). Покрытие всё ещё неполное относительно независимых оценок (~1000+ по Москве) - заменить на данные Бори/Сони с transport.mos.ru при появлении.`,
        date: '2026-09-20',
        stations,
      },
      null,
      2
    )
  );

  console.log(`\nобновлено: ${replaced} станций уточнены данными Яндекса, ${added} новых добавлено`);
  console.log('итого станций:', stations.length);
}

main();
