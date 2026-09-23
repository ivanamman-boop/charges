// Калибрует суточный профиль спроса p(h) (раздел 3.3) по реальным сессиям
// быстрых зарядок. Почасовых данных по Москве в открытом доступе нет (см.
// spec 3.3 и journal.md 23.09), поэтому берём ближайшее реальное: открытые
// данные Dundee City Council (Шотландия) - каждая сессия на городских
// хабах быстрой зарядки со временем начала, 2024 + янв-авг 2025.
//
// Сегмент клиента (P0/P1/T/C) в данных не указан, поэтому форма профилей
// сегментов из ТЗ (параметрические пики в params.json) сохраняется, а
// поверх неё подбирается общий множитель r(h), одинаковый для всех
// сегментов:  p_s(h) ∝ p~_s(h) · r(h). r(h) подбирается итеративно
// (пропорциональная подгонка), пока смесь сегментов с весами модели
// (D_s·m_s, 2026, base) не совпадёт с реальной кривой по городу.
// Итог: суммарная по городу кривая - реальная, разбивка по сегментам -
// по-прежнему допущение ТЗ.
//
// Запуск: npm run fit:hourly-profile  (--refresh - перекачать CSV Dundee)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { segmentDemand, hourlyProfile } from '../js/demand.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, 'data-sources', 'dundee-rapid-sessions-hourly.json');
const PARAMS_PATH = join(__dirname, '..', 'data', 'params.json');

// ArcGIS item id датасетов "Public EV Charge Point Usage Dundee City Council"
// (data.dundeecity.gov.uk). Выгрузка через /download портала не работает -
// отдаёт "Cannot fetch content entity", сам CSV лежит в item data ArcGIS.
const DATASETS = {
  '2024': '8b443deaf9174b7aa9d3e10eaa906422',
  '2025-01..08': 'e185a3a1cfc948a69ada76e950b9d447',
};
const DC_TYPES = new Set(['rapid', 'ultra_rapid']); // ac - медленные, не наш класс станций

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function fetchHourlyCounts() {
  if (existsSync(CACHE_PATH) && !process.argv.includes('--refresh')) {
    console.log('беру закэшированный агрегат:', CACHE_PATH);
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  }
  const counts = { weekday: new Array(24).fill(0), weekend: new Array(24).fill(0) };
  const days = { weekday: new Set(), weekend: new Set() };
  const sites = new Set();
  for (const [label, id] of Object.entries(DATASETS)) {
    const res = await fetch(`https://www.arcgis.com/sharing/rest/content/items/${id}/data`);
    if (!res.ok) throw new Error(`Dundee ${label}: HTTP ${res.status}`);
    const lines = (await res.text()).replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    const header = parseCsvLine(lines[0]);
    const iType = header.indexOf('Connector Type');
    const iStart = header.indexOf('Start');
    const iSite = header.indexOf('Site');
    let n = 0;
    for (const line of lines.slice(1)) {
      const row = parseCsvLine(line);
      if (!DC_TYPES.has(row[iType])) continue;
      const m = /^(\d\d)\/(\d\d)\/(\d{4}) (\d\d):/.exec(row[iStart]); // dd/mm/yyyy HH:MM, местное время
      if (!m) continue;
      const date = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
      const key = date.getUTCDay() === 0 || date.getUTCDay() === 6 ? 'weekend' : 'weekday';
      counts[key][+m[4]]++;
      days[key].add(`${m[3]}-${m[2]}-${m[1]}`);
      sites.add(row[iSite]);
      n++;
    }
    console.log(`Dundee ${label}: ${n} DC-сессий`);
  }
  const data = {
    source:
      'Dundee City Council, "Public EV Charge Point Usage" 2024 + Jan-Aug 2025 (data.dundeecity.gov.uk, ArcGIS items ' +
      Object.values(DATASETS).join(', ') +
      '): число начатых сессий по часу начала, только DC (rapid + ultra_rapid). Сырые CSV (~16МБ) не храним.',
    date: new Date().toISOString().slice(0, 10),
    sites: sites.size,
    days: { weekday: days.weekday.size, weekend: days.weekend.size },
    counts,
  };
  writeFileSync(CACHE_PATH, JSON.stringify(data, null, 1));
  return data;
}

function segmentWeights(dayType, params) {
  const M_GROUP = { P0: 'P', P1: 'P', T: 'T', C: 'C' };
  const w = {};
  for (const s of ['P0', 'P1', 'T', 'C']) {
    const m = params.M1_demand.m_weekday_weekend[M_GROUP[s]];
    w[s] = segmentDemand(s, 2026, 'base', params) * (dayType === 'weekend' ? m.value_weekend : m.value_weekday);
  }
  return w;
}

function mixture(dayType, params) {
  const w = segmentWeights(dayType, params);
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  const agg = new Array(24).fill(0);
  for (const s of Object.keys(w)) {
    const p = hourlyProfile(s, dayType, params);
    for (let h = 0; h < 24; h++) agg[h] += (w[s] / total) * p[h];
  }
  return agg;
}

const fmt = (arr) => arr.map((x) => (100 * x).toFixed(1).padStart(4)).join(' ');

async function main() {
  const data = await fetchHourlyCounts();
  const params = JSON.parse(readFileSync(PARAMS_PATH, 'utf8'));
  for (const dayType of ['weekday', 'weekend']) {
    const key = `hourly_correction_${dayType}`;
    const total = data.counts[dayType].reduce((a, b) => a + b, 0);
    const target = data.counts[dayType].map((c) => c / total);
    const before = (delete params.M1_demand[key], mixture(dayType, params));

    const r = new Array(24).fill(1);
    let it = 0;
    let maxErr = Infinity;
    for (; it < 200 && maxErr > 1e-6; it++) {
      params.M1_demand[key] = { value: r, tag: 'Р' };
      const agg = mixture(dayType, params);
      maxErr = 0;
      for (let h = 0; h < 24; h++) {
        maxErr = Math.max(maxErr, Math.abs(agg[h] - target[h]));
        r[h] *= target[h] / agg[h];
      }
      const mean = r.reduce((a, b) => a + b, 0) / 24; // масштаб r не важен (профиль нормируется), держим среднее = 1
      for (let h = 0; h < 24; h++) r[h] /= mean;
    }
    params.M1_demand[key] = {
      value: r.map((x) => Number(x.toFixed(4))),
      tag: 'Р',
      source:
        `множитель r(h) к профилям сегментов, подогнан (scripts/fit-hourly-profile.js, ${it} итераций) так, что сумма по городу ` +
        `совпадает с реальным суточным профилем DC-сессий Dundee (${total} сессий, ${data.days[dayType]} дней, ${data.sites} площадок). ` +
        'Разбивка по сегментам - допущение ТЗ, город-донор - не Москва (см. journal.md 23.09)',
    };
    console.log(`\n${dayType}: ${it} итераций, max |ошибка| ${maxErr.toExponential(1)}`);
    console.log('час      ' + Array.from({ length: 24 }, (_, h) => String(h).padStart(4)).join(' '));
    console.log('было, % ' + fmt(before));
    console.log('Dundee  ' + fmt(target));
    console.log('r(h)    ' + r.map((x) => x.toFixed(2).padStart(4)).join(' '));
  }
  writeFileSync(PARAMS_PATH, JSON.stringify(params, null, 2));
  console.log('\nзаписано в data/params.json');
}

main();
