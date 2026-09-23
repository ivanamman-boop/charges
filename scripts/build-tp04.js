// Трансформаторные подстанции 10(6,20)/0.4 кВ из OSM -> data/tp04.json.
// Нужны модулю 5 (7.2): площадка ближе 200 м к сети 0.4 кВ при P <= 150 кВт
// получает класс А (льготное присоединение) вместо Б. Источник - тот же
// кэш Overpass, что и у центров питания (fetch-real-centers.js), там эти
// ТП отбрасывались как "слишком мелкие для питающего центра".
//
// В OSM размечена лишь часть московских ТП (~4 тыс.), поэтому находка ТП
// ближе 200 м - доказательство класса А, а её отсутствие ничего не
// доказывает: такие площадки остаются "А|Б" и считаются консервативно как Б.
//
// Запуск: npm run build:tp04
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(__dirname, 'data-sources', 'osm-substations-moscow-raw.json'), 'utf8'));

const lowVoltage = (v) => String(v || '').split(';').some((x) => x === '400' || x === '230');
const points = [];
for (const e of raw.elements) {
  const t = e.tags || {};
  if (t.substation !== 'minor_distribution' && !lowVoltage(t.voltage)) continue;
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  if (typeof lat === 'number') points.push([Number(lat.toFixed(6)), Number(lon.toFixed(6))]);
}
writeFileSync(
  join(__dirname, '..', 'data', 'tp04.json'),
  JSON.stringify({
    source: 'OpenStreetMap (Overpass API, power=substation), area=Москва: substation=minor_distribution либо voltage с 400/230 В - трансформаторные подстанции сети 0.4 кВ. Размечена лишь часть реальных ТП города: ТП ближе 200 м = класс А, иначе класс не определён (считается как Б)',
    date: new Date().toISOString().slice(0, 10),
    points,
  })
);
console.log(`ТП 0.4 кВ: ${points.length} → data/tp04.json`);
