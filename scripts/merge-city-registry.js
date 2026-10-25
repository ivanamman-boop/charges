// Реестр городских зарядных станций Дептранса (data.mos.ru, набор 2985,
// выгрузка 14.07.2026, scripts/data-sources/mos-ev-stations-2985.json) поверх
// станций OSM + Яндекс.Карт. 408 станций с мощностью в названии
// («Станция №2, 22 кВт»), балансодержатель - Дептранс (сеть «Энергии Москвы»)
// и АО «Энергоцентр».
//
// - Станция модели в 100 м от записи реестра считается той же площадкой.
//   Если тип или мощность у неё оценены (P_known false или kind_source
//   «оценка...»), они заменяются реестром: мощность поста - наибольшая из
//   записей реестра на площадке, мощность площадки - их сумма, быстрая при
//   мощности от 50 кВт (22 и 44 кВт - AC). Известные данные Яндекса не
//   трогаем, расхождения считаем.
// - Записи реестра без станции модели в 100 м добавляются новыми станциями.
//
// Запускать после merge:yandex и перед clip:mkad (оба файла станций
// пересобираются merge:yandex).
//   node scripts/merge-city-registry.js
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAST_PATH = join(ROOT, 'data', 'stations.json');
const SLOW_PATH = join(ROOT, 'data', 'stations-slow.json');
const REG_PATH = join(ROOT, 'scripts', 'data-sources', 'mos-ev-stations-2985.json');
const MATCH_KM = 0.1;
const FAST_KW = 50;
const SOURCE = 'реестр Дептранса (data.mos.ru, набор 2985, 14.07.2026)';

const read = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
const fastRaw = read(FAST_PATH);
const slowRaw = read(SLOW_PATH);
const registry = read(REG_PATH);

const km = (a, b) => Math.hypot((a.lat - b.lat) * 111.32, (a.lon - b.lon) * 111.32 * Math.cos((55.75 * Math.PI) / 180));

const all = [...fastRaw.stations.filter((s) => s.status !== 'planned'), ...slowRaw.stations];
const planned = fastRaw.stations.filter((s) => s.status === 'planned');
const matches = new Map(); // станция -> мощности записей реестра
const added = [];
const shortAddress = (a) =>
  a
    .replace(/^Российская Федерация,\s*/, '')
    .replace(/^город Москва,\s*/, '')
    .replace(/внутригородская территория[^,]*,\s*/, '')
    .replace(/,?\s*дом\s+/, ', ')
    .replace(/,?\s*строение\s+/, 'с');

for (const r of registry) {
  const [lon, lat] = r.geodata_center.coordinates;
  const m = r.Name.match(/(\d+)\s*кВт/);
  if (!m) continue;
  const P = Number(m[1]);
  const pt = { lat, lon };
  let best = null;
  let bestD = Infinity;
  for (const s of all) {
    const d = km(pt, s);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  if (best && bestD <= MATCH_KM) {
    if (!matches.has(best)) matches.set(best, []);
    matches.get(best).push(P);
    continue;
  }
  const st = {
    id: `M-${r.global_id}`,
    lat,
    lon,
    operator: /Энергоцентр/i.test(r.BalanceHolder) ? 'Энергоцентр' : 'Энергия Москвы',
    P_kW: P,
    posts: 1,
    P_post_kW: P,
    status: 'active',
    year_open: 2026,
    source_detail: 'mos.ru',
    P_known: true,
    kind: P >= FAST_KW ? 'fast' : 'slow',
    kind_source: SOURCE,
    address: shortAddress(r.Address),
    address_source: 'mos.ru',
  };
  added.push(st);
  all.push(st);
}

let updated = 0;
let conflicts = 0;
for (const [s, powers] of matches) {
  const Pmax = Math.max(...powers);
  const kind = Pmax >= FAST_KW ? 'fast' : 'slow';
  const estimated = !s.P_known || String(s.kind_source || '').startsWith('оценка');
  if (!estimated) {
    if (s.kind !== kind) conflicts++;
    continue;
  }
  s.kind = kind;
  s.kind_source = SOURCE;
  s.P_post_kW = Pmax;
  s.P_kW = Math.max(Pmax, powers.reduce((a, b) => a + b, 0));
  s.P_known = true;
  s.P_source = SOURCE;
  updated++;
}

const active = all.filter((s) => s.status !== 'planned');
fastRaw.stations = [...active.filter((s) => s.kind === 'fast'), ...planned];
slowRaw.stations = active.filter((s) => s.kind === 'slow');
const note = ` | + ${SOURCE}: тип и мощность у станций с оценкой, новые станции реестра`;
for (const raw of [fastRaw, slowRaw]) if (!raw.source.includes('реестр Дептранса')) raw.source += note;
writeFileSync(FAST_PATH, JSON.stringify(fastRaw, null, 2));
writeFileSync(SLOW_PATH, JSON.stringify(slowRaw, null, 2));
console.log(
  `реестр: ${registry.length} записей; совпали с ${matches.size} станциями, у ${updated} тип и мощность взяты из реестра, ` +
    `расхождений с известными данными ${conflicts}; новых станций ${added.length} (быстрых ${added.filter((s) => s.kind === 'fast').length}); ` +
    `итого быстрых ${fastRaw.stations.length - planned.length}, медленных ${slowRaw.stations.length}`
);
