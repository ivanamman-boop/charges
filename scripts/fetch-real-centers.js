// Реальные координаты центров питания (подстанций) Москвы из OpenStreetMap
// (Overpass API, power=substation) вместо случайно раскиданных по кругу
// синтетических точек generate-synthetic-data.js.
//
// Честное ограничение (в отличие от stations.json, где Яндекс.Карты дали
// РЕАЛЬНУЮ мощность/оператора): OSM не знает резерва мощности подстанции -
// это внутренние эксплуатационные данные Россетей, публично не выложены в
// открытом виде (пробовали найти "карту питающих центров" Россети МР -
// обе найденные ссылки на 2026-09-23 мертвы, см. docs/journal.md). Поэтому
// reserve_MVA/bus_planned_kW ЗДЕСЬ ТОЖЕ ОЦЕНКА (грубая эвристика по классу
// напряжения + случайность), только координаты реальные. Как появятся
// официальные данные Россети МР - заменить оценку, координаты трогать не
// придётся.
//
// Сырые данные закэшированы в scripts/data-sources/
// osm-substations-moscow-raw.json. Чтобы обновить:
//   npm run fetch:centers -- --refresh
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, 'data-sources', 'osm-substations-moscow-raw.json');
const OUTPUT_PATH = join(__dirname, '..', 'data', 'centers.json');

const OVERPASS_QUERY = `
[out:json][timeout:60];
area["name"="Москва"]["boundary"="administrative"]["admin_level"="4"]->.msk;
(
  node["power"="substation"](area.msk);
  way["power"="substation"](area.msk);
);
out center;
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

function maxVoltage(tags) {
  const v = tags.voltage;
  if (!v) return 0;
  const nums = String(v)
    .split(';')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x));
  return nums.length ? Math.max(...nums) : 0;
}

function isFeedingSubstation(tags) {
  const type = tags.substation;
  return type === 'transmission' || type === 'distribution' || maxVoltage(tags) >= 35000;
}

// Резерв - НЕ измеренная величина (см. комментарий выше), грубая оценка по
// классу напряжения: чем выше класс, тем крупнее обычно подстанция и тем
// больше у неё установленная мощность (это общее свойство сетей, не
// специфика Москвы) - но именно РЕЗЕРВ (свободная мощность) зависит от
// текущей загрузки, которую без данных Россетей узнать нельзя.
// Берём НИЖНЮЮ границу диапазона класса (раньше - случайное число внутри
// диапазона без seed: значения менялись при каждом запуске, а от них зависят
// класс подключения В и выбор площадок модулем 8; аудит 24.09). Нижняя
// граница - консервативно и воспроизводимо.
function estimateReserveMVA(voltageV) {
  if (voltageV >= 220000) return 40; // диапазон 40-120
  if (voltageV >= 110000) return 10; // 10-40
  return 2; // 2-15: 35 кВ и ниже, либо класс напряжения неизвестен
}

async function main() {
  const raw = await loadRaw();
  const elements = raw.elements.filter((e) => (e.lat && e.lon) || e.center);
  const candidates = elements.filter((e) => isFeedingSubstation(e.tags || {}));

  // Дедупликация по округлённым координатам (4 знака ~= 11м) - node и way
  // одной и той же подстанции иногда попадают в выдачу оба.
  const seen = new Set();
  const centers = [];
  for (const e of candidates) {
    const lat = e.lat ?? e.center.lat;
    const lon = e.lon ?? e.center.lon;
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const tags = e.tags || {};
    const voltageV = maxVoltage(tags);
    centers.push({
      id: `PS-${String(100 + centers.length)}`,
      lat: Number(lat.toFixed(5)),
      lon: Number(lon.toFixed(5)),
      reserve_MVA: Number(estimateReserveMVA(voltageV).toFixed(2)),
      bus_planned_kW: 0, // планируемые электробусные зарядки - данных нет (раньше - случайные у 15% подстанций)
      reserve_date: new Date().toISOString().slice(0, 10),
      name: tags.name || null, // справочно, расчётом не используется
      voltage_kV: voltageV ? voltageV / 1000 : null, // справочно
      osm_id: e.id,
    });
  }

  writeFileSync(
    OUTPUT_PATH,
    JSON.stringify(
      {
        source: `OpenStreetMap (Overpass API, power=substation, класс transmission/distribution либо напряжение >=35кВ), area=Москва. Координаты реальные, ${centers.length} подстанций. reserve_MVA - ОЦЕНКА: нижняя граница диапазона по классу напряжения (220 кВ - 40, 110 кВ - 10, прочие - 2 МВА), bus_planned_kW - 0 (данных нет) (не измеренные данные Россетей: публичная "карта питающих центров" на 2026-09-23 недоступна, см. docs/journal.md) - заменить при появлении официальных данных.`,
        date: new Date().toISOString().slice(0, 10),
        centers,
      },
      null,
      2
    )
  );

  console.log(`data/centers.json переписан: ${centers.length} подстанций из OSM (было в OSM-выдаче: ${elements.length}, из них подошли по классу/напряжению: ${candidates.length})`);
}

main();
