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
const SLOW_PATH = join(__dirname, '..', 'data', 'stations-slow.json');

// Детерминированное число [0,1) из id - "бросок монетки" без генератора,
// воспроизводимый при любом порядке станций.
function hashUnit(str) {
  let h = 2166136261;
  for (const ch of str) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

// Тип (быстрая/медленная) там, где данных нет: доля быстрых среди известных
// станций того же оператора (если известных >= 5), иначе по всем известным -
// станция быстрая, если hashUnit(id) < доли. Так ожидаемое число быстрых у
// оператора совпадает с его наблюдаемой долей, а не "всё в большинство".
// Мощность быстрой станции без данных - медиана известных быстрых у
// оператора (>= 3 значений), иначе медиана по всем известным быстрым.
function imputeKindAndPower(stations) {
  const byOp = new Map();
  for (const s of stations) {
    if (!byOp.has(s.operator)) byOp.set(s.operator, []);
    byOp.get(s.operator).push(s);
  }
  const known = stations.filter((s) => s.kind !== 'unknown');
  const shareAll = known.filter((s) => s.kind === 'fast').length / known.length;
  let kindCount = 0;
  for (const s of stations) {
    if (s.kind !== 'unknown') continue;
    const opKnown = byOp.get(s.operator).filter((x) => x.kind !== 'unknown');
    const share = opKnown.length >= 5 ? opKnown.filter((x) => x.kind === 'fast').length / opKnown.length : shareAll;
    s.kind = hashUnit(s.id + s.operator) < share ? 'fast' : 'slow';
    s.kind_source = `оценка: ${Math.round(share * 100)}% быстрых ${opKnown.length >= 5 ? 'у оператора' : 'по всем'}`;
    kindCount++;
  }
  const median = (a) => {
    const v = [...a].sort((x, y) => x - y);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };
  const fastKnownP = (list) => list.filter((x) => x.kind === 'fast' && x.P_known).map((x) => x.P_kW);
  const allP = median(fastKnownP(stations)) ?? 60;
  let powerCount = 0;
  for (const s of stations) {
    if (s.kind !== 'fast' || s.P_known) continue;
    const opP = fastKnownP(byOp.get(s.operator));
    const P = opP.length >= 3 ? median(opP) : allP;
    const tier = tierFor(P);
    s.P_kW = tier.P_kW;
    s.P_post_kW = tier.P_post_kW;
    s.P_source = `оценка: медиана быстрых ${opP.length >= 3 ? 'у оператора' : 'по всем'}`;
    powerCount++;
  }
  return { kind: kindCount, power: powerCount };
}

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

const DC_PLUGS = new Set(['ccs_combo', 'ccs_combo_1', 'gbt_dc', 'chademo_dcfc', 'tesla_supercharger']);

// Быстрая/медленная по данным Яндекса: мощность (>= 40 кВт - DC) → поле
// "скорость зарядки" → типы разъёмов. Нет ничего - unknown, решается ниже по
// доле быстрых у того же оператора.
function kindOfYandex(powerKW, features) {
  if (powerKW) return { kind: powerKW >= 40 ? 'fast' : 'slow', kind_source: 'мощность' };
  const speed = features.find((f) => f.id === 'charging_speed')?.value;
  const speeds = new Set(Array.isArray(speed) ? speed.map((x) => x.id) : []);
  if (speeds.has('fast')) return { kind: 'fast', kind_source: 'скорость (Яндекс)' };
  if (speeds.has('slow')) return { kind: 'slow', kind_source: 'скорость (Яндекс)' };
  const plugs = features.find((f) => f.id === 'plugtype')?.value;
  const ids = Array.isArray(plugs) ? plugs.map((x) => x.id) : [];
  if (ids.some((x) => DC_PLUGS.has(x))) return { kind: 'fast', kind_source: 'разъёмы' };
  if (ids.length) return { kind: 'slow', kind_source: 'разъёмы' };
  return { kind: 'unknown', kind_source: null };
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

  return { lat, lon, operator, P_kW: tier.P_kW, posts, P_post_kW: tier.P_post_kW, status: 'active', year_open: 2024, P_known: powerKW !== null, ...kindOfYandex(powerKW, features) };
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
      const prev = stations[nearestIdx];
      // Яндекс уточняет координаты/оператора; тип и мощность из OSM берём,
      // если у Яндекса их нет, а у OSM есть.
      const keepOsm = cand.kind === 'unknown' && prev.kind !== 'unknown';
      stations[nearestIdx] = {
        id: prev.id, lat: cand.lat, lon: cand.lon, operator: cand.operator,
        P_kW: !cand.P_known && prev.P_known ? prev.P_kW : cand.P_kW,
        posts: cand.posts,
        P_post_kW: !cand.P_known && prev.P_known ? prev.P_post_kW : cand.P_post_kW,
        status: cand.status, year_open: cand.year_open, source_detail: 'yandex',
        P_known: cand.P_known || prev.P_known,
        kind: keepOsm ? prev.kind : cand.kind,
        kind_source: keepOsm ? prev.kind_source : cand.kind_source,
      };
      replaced++;
    } else {
      stations.push({ id: `S-${String(stations.length + 1).padStart(4, '0')}`, lat: cand.lat, lon: cand.lon, operator: cand.operator, P_kW: cand.P_kW, posts: cand.posts, P_post_kW: cand.P_post_kW, status: cand.status, year_open: cand.year_open, source_detail: 'yandex', P_known: cand.P_known, kind: cand.kind, kind_source: cand.kind_source });
      added++;
    }
  }

  const imputed = imputeKindAndPower(stations);
  const fast = stations.filter((s) => s.kind === 'fast');
  const slow = stations.filter((s) => s.kind === 'slow');
  writeFileSync(
    SLOW_PATH,
    JSON.stringify({ source: 'Медленные (AC, до ~22 кВт) станции из тех же источников, что data/stations.json - в модель не входят (задание про быстрые ЭЗС), для справки', date: new Date().toISOString().slice(0, 10), stations: slow }, null, 2)
  );
  console.log(`быстрых ${fast.length}, медленных ${slow.length} → data/stations-slow.json; тип по оператору дооценён у ${imputed.kind}, мощность у ${imputed.power}`);

  const osmOnly = fast.filter((s) => s.source_detail !== 'yandex').length;
  writeFileSync(
    STATIONS_PATH,
    JSON.stringify(
      {
        source: `OpenStreetMap (Overpass API, ${osmOnly} только-OSM) + Яндекс.Карты (вручную собранные ответы поиска "Электрозаправки" из DevTools, см. scripts/data-sources/yandex-charging-stations-compact.json: ${stations.length - osmOnly} станций уточнены/добавлены Яндексом суммарно за все объезды карты, из них ${replaced} уточнили существующие точки и ${added} добавили новых на этом прогоне). Покрытие всё ещё неполное относительно независимых оценок (~1000+ по Москве) - заменить на данные Бори/Сони с transport.mos.ru при появлении.`,
        date: new Date().toISOString().slice(0, 10),
        stations: fast,
      },
      null,
      2
    )
  );

  console.log(`\nобновлено: ${replaced} станций уточнены данными Яндекса, ${added} новых добавлено`);
  console.log('итого станций:', stations.length);
}

main();
