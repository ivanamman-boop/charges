// Ограничивает модель Москвой внутри МКАД: обрезает data/cells.json (сетка
// спроса) и data/stations.json по контуру data/mkad.json.
//
// Почему: станции с Яндекс.Карт собирались только внутри МКАД (пользователь,
// 23.09) - внутри 921 из 984 станций, а ячеек спроса снаружи вдвое больше,
// чем внутри (Новая Москва, приграничье). Модель видела за МКАДом огромный
// спрос почти без станций, рекомендации модуля 8 уходили туда (4 из 8,
// №1 - Коммунарка), а спрос из-за МКАДа давил на станции у кольца. Это
// артефакт неполных данных о станциях, а не находка.
//
// Последний шаг цепочки данных: fetch:stations → merge:yandex → ... →
// assign:demand-layers → clip:mkad. Исходные скрипты пересоздают полные
// файлы, повторный clip идемпотентен.
//
// Запуск: npm run clip:mkad
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data');
const read = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));
const ring = read('mkad.json').ring;

function insideMkad(lat, lon) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ai, bi] = ring[i];
    const [aj, bj] = ring[j];
    if (ai > lat !== aj > lat && lon < ((bj - bi) * (lat - ai)) / (aj - ai) + bi) inside = !inside;
  }
  return inside;
}

const NOTE = ' | Обрезано по МКАД (scripts/clip-to-mkad.js, data/mkad.json): модель считается для Москвы внутри МКАД, где станции собраны полно.';
for (const [file, key] of [
  ['cells.json', 'cells'],
  ['stations.json', 'stations'],
  ['stations-slow.json', 'stations'],
]) {
  if (!existsSync(join(DATA, file))) continue;
  const raw = read(file);
  const before = raw[key].length;
  raw[key] = raw[key].filter((x) => insideMkad(x.lat, x.lon));
  if (!raw.source.includes('Обрезано по МКАД')) raw.source += NOTE;
  writeFileSync(join(DATA, file), JSON.stringify(raw, null, 2));
  console.log(`${file}: ${before} → ${raw[key].length} внутри МКАД`);
}
