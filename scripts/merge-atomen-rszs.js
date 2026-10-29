// Реестр станций РСЗС с карты atomen.ru поверх станций модели.
//
// РСЗС (ответы команде, 29.10.2026) назвал https://atomen.ru/map/ реестром
// своих станций. Страница сохранена в scripts/data-sources/atomen-rszs-2026-10-29.json:
// 126 зарядных устройств (ЭЗС) в Москве на 112 площадках. До слияния в
// модели как РСЗС было 86 из 105 площадок внутри МКАД: часть записана как
// «Энергия Москвы» (городская программа, которую ведёт РСЗС), а площадок
// Елецкая 4к11, Воронежская 3, Востряковский пр. 7 (их РСЗС назвал самыми
// слабыми) не было вовсе.
//
// Правила:
// - ЭЗС на одной точке реестра - одна площадка. Мощность поста - тип ЭЗС
//   (DC 60 / DC 150), число постов - число ЭЗС (одна машина на устройство
//   на полной мощности), мощность площадки - их сумма. ЭЗС меньше 50 кВт
//   (DC 42) - медленные, модель их не считает.
// - Действующая быстрая станция модели в 150 м от площадки реестра - та же
//   площадка (в 250 м, если в модели она уже РСЗС: координаты Яндекса
//   бывают сдвинуты). Ей ставится оператор РСЗС и координаты реестра.
//   Мощность и посты заменяются реестром, только если у станции они
//   оценены; известные данные Яндекса и Дептранса не трогаем.
// - Площадка реестра без станции модели рядом добавляется новой станцией.
//
// Запуск после merge:city и перед clip:mkad (clip расставит outside_mkad):
//   node scripts/merge-atomen-rszs.js && npm run clip:mkad
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAST_PATH = join(ROOT, 'data', 'stations.json');
const REG_PATH = join(ROOT, 'scripts', 'data-sources', 'atomen-rszs-2026-10-29.json');
const SOURCE = 'реестр РСЗС (atomen.ru/map, 29.10.2026)';
const MATCH_KM = 0.15;
const MATCH_RSZS_KM = 0.25;
const FAST_KW = 50;

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const fastRaw = read(FAST_PATH);
const reg = read(REG_PATH);
const km = (a, b) => Math.hypot((a.lat - b.lat) * 111.32, (a.lon - b.lon) * 111.32 * Math.cos((55.75 * Math.PI) / 180));
const shortAddress = (a) => a.replace(/^г\.\s*Москва,\s*/, '').trim();

// площадки реестра: ЭЗС в 60 м друг от друга - одна площадка (одну площадку
// реестр иногда пишет двумя точками в паре метров)
const SITE_KM = 0.06;
const siteList = [];
for (const r of reg.records) {
  const pt = { lat: Number(r.latitude), lon: Number(r.longitude) };
  const kW = Number((r.type.match(/(\d+)/) || [])[1]);
  let s = siteList.find((x) => km(x, pt) <= SITE_KM);
  if (!s) { s = { ...pt, address: shortAddress(r.address), units: [], kW: [] }; siteList.push(s); }
  s.units.push(r.station.replace(/^ЭЗС\s*№\s*/, ''));
  s.kW.push(kW);
}
const sites = new Map(siteList.map((s, i) => [i, s]));

const active = fastRaw.stations.filter((s) => s.status === 'active');
const used = new Set();
let relabeled = 0, powered = 0, moved = 0;
const added = [];
for (const site of sites.values()) {
  const fastKW = site.kW.filter((k) => k >= FAST_KW);
  if (!fastKW.length) continue;
  const P_post = Math.max(...fastKW);
  const P = fastKW.reduce((a, b) => a + b, 0);
  let best = null, bestD = Infinity;
  for (const s of active) {
    if (used.has(s)) continue;
    const d = km(site, s);
    const limit = s.operator === 'РСЗС' ? MATCH_RSZS_KM : MATCH_KM;
    if (d <= limit && d < bestD) { best = s; bestD = d; }
  }
  if (best) {
    used.add(best);
    if (best.operator !== 'РСЗС') { best.operator_before = best.operator ?? null; best.operator = 'РСЗС'; relabeled++; }
    best.operator_source = SOURCE;
    if (bestD > 0.03) { best.lat = site.lat; best.lon = site.lon; moved++; }
    const estimated = !best.P_known || String(best.P_source || '').startsWith('оценка') || String(best.kind_source || '').startsWith('оценка');
    if (estimated) {
      best.P_kW = P; best.posts = fastKW.length; best.P_post_kW = P_post;
      best.P_known = true; best.P_source = SOURCE; powered++;
    }
    best.rszs_units = site.units;
    continue;
  }
  const st = {
    id: `R-${site.units[0]}`,
    lat: site.lat,
    lon: site.lon,
    operator: 'РСЗС',
    operator_source: SOURCE,
    P_kW: P,
    posts: fastKW.length,
    P_post_kW: P_post,
    P_known: true,
    P_source: SOURCE,
    kind: 'fast',
    kind_source: SOURCE,
    status: 'active',
    year_open: 2025, // дата запуска в реестре не указана; работает больше полугода (РСЗС про слабые станции)
    address: site.address,
    address_source: SOURCE,
    rszs_units: site.units,
  };
  added.push(st);
}
fastRaw.stations.push(...added);

// Станции, которые Яндекс подписал РСЗС, но которых нет в реестре компании:
// реестр РСЗС главнее, метку снимаем (станция остаётся конкурентом).
let unlabeled = 0;
for (const s of active) {
  // вторая запись той же площадки в нашей базе (хаб) - тоже РСЗС
  if (s.operator === 'РСЗС' && !used.has(s) && siteList.some((x) => km(x, s) <= MATCH_RSZS_KM)) { s.operator_source = SOURCE; continue; }
  if (s.operator === 'РСЗС' && !used.has(s)) {
    s.operator_before = 'РСЗС';
    s.operator = 'независимый';
    s.operator_source = `нет в ${SOURCE}`;
    unlabeled++;
  }
}
if (!fastRaw.source.includes('atomen.ru')) fastRaw.source += ` | + ${SOURCE}: оператор РСЗС, мощность у станций с оценкой, недостающие площадки`;
writeFileSync(FAST_PATH, JSON.stringify(fastRaw, null, 2));
console.log(`реестр: ${reg.records.length} ЭЗС на ${sites.size} площадках; метка РСЗС снята у ${unlabeled} станций вне реестра; совпали ${used.size} (перепомечены в РСЗС ${relabeled}, сдвинуты на координаты реестра ${moved}, мощность из реестра ${powered}); добавлены ${added.length}: ${added.map((s) => s.address).join('; ')}`);
