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

// Станции сразу за МКАДом остаются конкурентами (25.10): водитель из
// Ивановского или Новогиреева спокойно заряжается в Реутове. Без них у
// кандидатов у кольца (L-006, L-011) модель видела 2 станции в 2 км вместо
// 20 и завышала новых клиентов - краевой эффект обрезки. Спрос (cells)
// по-прежнему только внутри МКАД; станции полосы помечены outside_mkad и
// не входят в калибровку D0, сеть РСЗС и счётчики сайта.
const BUFFER_KM = 3;
const kmPerDegLat = 111.32;
const kmPerDegLon = 111.32 * Math.cos((55.75 * Math.PI) / 180);
function distToRingKm(lat, lon) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][1] * kmPerDegLon, ay = ring[j][0] * kmPerDegLat;
    const bx = ring[i][1] * kmPerDegLon, by = ring[i][0] * kmPerDegLat;
    const px = lon * kmPerDegLon, py = lat * kmPerDegLat;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
  }
  return best;
}

const NOTE = ' | Обрезано по МКАД (scripts/clip-to-mkad.js, data/mkad.json): спрос - внутри МКАД; станции - внутри и в полосе 3 км за МКАДом как конкуренты (outside_mkad).';
for (const [file, key] of [
  ['cells.json', 'cells'],
  ['stations.json', 'stations'],
  ['stations-slow.json', 'stations'],
]) {
  if (!existsSync(join(DATA, file))) continue;
  const raw = read(file);
  const before = raw[key].length;
  if (key === 'cells') {
    raw[key] = raw[key].filter((x) => insideMkad(x.lat, x.lon));
  } else {
    raw[key] = raw[key].filter((x) => {
      if (insideMkad(x.lat, x.lon)) {
        delete x.outside_mkad;
        return true;
      }
      if (x.status === 'planned' || distToRingKm(x.lat, x.lon) > BUFFER_KM) return false;
      x.outside_mkad = true;
      return true;
    });
  }
  if (!raw.source.includes('Обрезано по МКАД')) raw.source += NOTE;
  writeFileSync(join(DATA, file), JSON.stringify(raw, null, 2));
  const out = raw[key].filter((x) => x.outside_mkad).length;
  console.log(`${file}: ${before} → ${raw[key].length - out} внутри МКАД${out ? ` + ${out} в полосе ${BUFFER_KM} км за МКАДом` : ''}`);
}
