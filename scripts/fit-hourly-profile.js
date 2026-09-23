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
// Те же данные дают и календарные множители спроса (3.4), тоже придуманные
// в ТЗ: сезон ζ (зима/лето) и тип дня m (будни/выходные). Лог-линейная
// регрессия числа сессий за день: log n = a + b·t + c·[зима] + e·[выходной],
// где тренд b обязателен - в Dundee сессий на хаб со временем меньше
// (сеть растёт), без него сезонность смазалась бы трендом.
//  - ζ: отношение зима/лето = exp(c), нормировка ТЗ (5ζ_зима + 7ζ_лето)/12 = 1.
//  - m: сегментная форма ТЗ (C в выходные 0, у частников выходные выше)
//    сохраняется, общий множитель k к выходным подбирается так, чтобы
//    отношение выходные/будни по городу = exp(e); у каждого сегмента
//    (5m_буд + 2m_вых)/7 = 1.
// Dundee теплее Москвы - зимний эффект оттуда скорее нижняя граница.
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
  const daily = {}; // "yyyy-mm-dd" -> число DC-сессий
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
      daily[`${m[3]}-${m[2]}-${m[1]}`] = (daily[`${m[3]}-${m[2]}-${m[1]}`] || 0) + 1;
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
    daily,
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

// Решение нормальных уравнений (XᵀX)β = XᵀY методом Гаусса - 4 параметра.
function leastSquares(X, Y) {
  const k = X[0].length;
  const A = Array.from({ length: k }, (_, i) => [...Array.from({ length: k }, (_, j) => X.reduce((s, row) => s + row[i] * row[j], 0)), X.reduce((s, row, n) => s + row[i] * Y[n], 0)]);
  for (let i = 0; i < k; i++) {
    for (let r = i + 1; r < k; r++) {
      const f = A[r][i] / A[i][i];
      for (let c = i; c <= k; c++) A[r][c] -= f * A[i][c];
    }
  }
  const beta = new Array(k).fill(0);
  for (let i = k - 1; i >= 0; i--) beta[i] = (A[i][k] - A[i].slice(i + 1, k).reduce((s, a, j) => s + a * beta[i + 1 + j], 0)) / A[i][i];
  return beta;
}

const WINTER = new Set([11, 12, 1, 2, 3]); // как в economics.js (3.4)

function fitCalendar(data, params) {
  const dates = Object.keys(data.daily).sort();
  const t0 = Date.parse(dates[0]);
  const X = [];
  const Y = [];
  for (const d of dates) {
    const n = data.daily[d];
    if (n < 20) continue; // дни со сбоем выгрузки/ремонтом хабов
    const date = new Date(d + 'T00:00:00Z');
    X.push([1, (Date.parse(d) - t0) / (365 * 864e5), WINTER.has(date.getUTCMonth() + 1) ? 1 : 0, date.getUTCDay() === 0 || date.getUTCDay() === 6 ? 1 : 0]);
    Y.push(Math.log(n));
  }
  const [, trend, cWinter, eWeekend] = leastSquares(X, Y);
  const winterRatio = Math.exp(cWinter);
  const weekendRatio = Math.exp(eWeekend);
  const src = `Dundee, ${X.length} дней DC-сессий 2024-2025, регрессия log n = a + тренд + зима + выходной (scripts/fit-hourly-profile.js)`;

  const m1 = params.M1_demand;
  const summer = 12 / (5 * winterRatio + 7);
  m1.zeta_season.winter = { ...m1.zeta_season.winter, value: Number((winterRatio * summer).toFixed(4)), tag: 'Р', source: `${src}: зима/лето = ${winterRatio.toFixed(3)}, нормировка (5ζз+7ζл)/12=1. Dundee теплее Москвы - скорее нижняя граница` };
  m1.zeta_season.summer = { ...m1.zeta_season.summer, value: Number(summer.toFixed(4)), tag: 'Р', source: m1.zeta_season.winter.source };

  // Тип дня: исходная сегментная форма ТЗ хранится в shape_weekend (при
  // первом запуске берётся из текущих value_weekend), чтобы повторные
  // запуски не накапливали множитель.
  const mw = m1.m_weekday_weekend;
  for (const g of Object.values(mw)) if (g.shape_weekend === undefined) g.shape_weekend = g.value_weekend;
  const apply = (k) => {
    for (const g of Object.values(mw)) {
      g.value_weekend = Math.min(3.5, g.shape_weekend * k); // (5m_буд+2m_вых)/7=1 требует m_вых <= 3.5
      g.value_weekday = (7 - 2 * g.value_weekend) / 5;
    }
  };
  const aggRatio = () => {
    const wk = segmentWeights('weekend', params);
    const wd = segmentWeights('weekday', params);
    return Object.values(wk).reduce((a, b) => a + b, 0) / Object.values(wd).reduce((a, b) => a + b, 0);
  };
  let lo = 0.1;
  let hi = 3;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    apply(mid);
    if (aggRatio() < weekendRatio) lo = mid;
    else hi = mid;
  }
  apply((lo + hi) / 2);
  for (const g of Object.values(mw)) {
    g.value_weekday = Number(g.value_weekday.toFixed(4));
    g.value_weekend = Number(g.value_weekend.toFixed(4));
    g.tag = 'Р';
    g.source = `${src}: выходные/будни по городу = ${weekendRatio.toFixed(3)}; сегментная форма ТЗ (shape_weekend) сохранена, общий множитель подогнан`;
  }
  console.log(`календарь: тренд ${((Math.exp(trend) - 1) * 100).toFixed(1)}%/год, зима/лето ${winterRatio.toFixed(3)} → ζ зима ${m1.zeta_season.winter.value}, лето ${m1.zeta_season.summer.value}; выходные/будни ${weekendRatio.toFixed(3)} →`, Object.fromEntries(Object.entries(mw).map(([k, g]) => [k, `${g.value_weekday}/${g.value_weekend}`])));
}

async function main() {
  const data = await fetchHourlyCounts();
  const params = JSON.parse(readFileSync(PARAMS_PATH, 'utf8'));
  if (!data.daily) throw new Error('в кэше нет посуточных данных - запустите с --refresh');
  // Календарь раньше профиля: веса сегментов в смеси профиля зависят от m.
  fitCalendar(data, params);
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
