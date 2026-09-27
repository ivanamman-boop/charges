// Модуль 1. Спрос (спецификация, раздел 3). Чистые функции, без DOM.
// Сегменты всегда в порядке ['P0','P1','T','C'].
export const SEGMENTS = ['P0', 'P1', 'T', 'C'];

const M_GROUP = { P0: 'P', P1: 'P', T: 'T', C: 'C' };
// g_private применяется к P0/P1/C (в спецификации отдельно задан только рост
// такси, остальные сегменты растут вместе с частным парком, раздел 3.1).
const GROWTH_GROUP = { P0: 'private', P1: 'private', T: 'taxi', C: 'private' };

const Y0 = 2026;

// 3.1. Базовый суточный спрос сегмента в году y при сценарии k.
export function segmentDemand(segment, year, scenario, params) {
  const d1 = params.M1_demand;
  const theta = d1.theta[segment].value;
  const D0 = d1.D0.value;
  if (D0 === null || D0 === undefined) {
    throw new Error('D0 не откалиброван (params.M1_demand.D0.value === null)');
  }
  let g;
  if (GROWTH_GROUP[segment] === 'taxi') {
    g = d1.g_taxi[scenario].value;
  } else {
    g = d1.g_private[scenario].value;
  }
  return theta * D0 * Math.pow(1 + g, year - Y0);
}

// Спрос по городу в году y относительно 2026 (сумма сегментов, сценарий k).
export function demandMultiplier(year, scenario, params) {
  let now = 0;
  let base = 0;
  for (const s of SEGMENTS) {
    now += segmentDemand(s, year, scenario, params);
    base += segmentDemand(s, Y0, scenario, params);
  }
  return base > 0 ? now / base : 1;
}

// Сколько городских станций внутри МКАД открывается в году y при сценарии k
// (26.09). План «Энергии Москвы» (params.planned_network) рассчитан под
// базовый рост: 200 станций в год внутри МКАД. Город строит под спрос,
// поэтому при другом сценарии годовая квота пропорциональна приросту спроса
// за этот год относительно базового: медленный рост - меньше станций,
// быстрый - больше. Иначе при медленном росте город ставил бы станции,
// которым некого обслуживать, и новые станции к 2030 теряли бы клиентов.
export function plannedStationsPerYear(year, scenario, params) {
  const plan = params.planned_network;
  const perYear = Math.round((plan.points_per_year.value / plan.posts_per_station.value) * plan.share_inside_mkad.value);
  if (scenario === 'base') return perYear;
  const inc = (k) => demandMultiplier(year, k, params) - demandMultiplier(year - 1, k, params);
  const b = inc('base');
  return b > 0 ? Math.round((perYear * inc(scenario)) / b) : perYear;
}

// Работает ли станция в году y при сценарии k. Городская (status planned)
// открывается, только если её номер в очереди своего года (plan_rank)
// меньше квоты этого года: add-planned-stations.js расставляет запас под
// быстрый сценарий, в базовом и медленном строятся первые по очереди.
export function isStationActive(station, year, scenario, params) {
  if (station.year_open > year) return false;
  if (station.status !== 'planned' || station.plan_rank === undefined || !params) return true;
  return station.plan_rank < plannedStationsPerYear(station.year_open, scenario, params);
}

export function stationsActiveIn(stations, year, scenario, params) {
  return stations.filter((s) => isStationActive(s, year, scenario, params));
}

// 3.2. Веса ячеек w_{s,i} по слоям cells.json, нормированные на сумму = 1.
export function cellWeights(cells, params) {
  const weights = params.M1_demand.layer_weights;
  const layers = ['res', 'work', 'poi', 'road', 'taxi'];
  const result = {};
  for (const s of SEGMENTS) {
    const a = weights[s];
    const raw = new Float64Array(cells.length);
    let sum = 0;
    for (let i = 0; i < cells.length; i++) {
      let v = 0;
      for (const l of layers) v += a[l] * cells[i].layers[l];
      raw[i] = v;
      sum += v;
    }
    const w = new Float64Array(cells.length);
    for (let i = 0; i < cells.length; i++) w[i] = sum > 0 ? raw[i] / sum : 0;
    result[s] = w;
  }
  return result;
}

function circularDelta(h, mu) {
  const d = Math.abs(h - mu);
  return Math.min(d, 24 - d);
}

// 3.3. Профиль по часам p_{s,d}(h), нормированный на сумму по часам = 1.
// r(h) - общий для всех сегментов множитель, подогнанный под реальный
// суточный профиль DC-сессий (scripts/fit-hourly-profile.js); без него
// (T6 с плоским профилем) - чистая параметрическая форма из ТЗ.
export function hourlyProfile(segment, dayType, params) {
  const table =
    dayType === 'weekend' ? params.M1_demand.hourly_profile_weekend : params.M1_demand.hourly_profile_weekday;
  const cfg = table[segment];
  const r = params.M1_demand[`hourly_correction_${dayType === 'weekend' ? 'weekend' : 'weekday'}`]?.value;
  const raw = new Float64Array(24);
  let sum = 0;
  for (let h = 0; h < 24; h++) {
    let v = cfg.b;
    for (const peak of cfg.peaks) {
      const delta = circularDelta(h, peak.mu);
      v += peak.A * Math.exp(-(delta * delta) / (2 * peak.sigma * peak.sigma));
    }
    if (r) v *= r[h];
    raw[h] = v;
    sum += v;
  }
  const p = new Float64Array(24);
  for (let h = 0; h < 24; h++) p[h] = sum > 0 ? raw[h] / sum : 0;
  return p;
}

function dayMultiplier(segment, dayType, params) {
  const group = M_GROUP[segment];
  const cfg = params.M1_demand.m_weekday_weekend[group];
  return dayType === 'weekend' ? cfg.value_weekend : cfg.value_weekday;
}

function seasonMultiplier(season, params) {
  return params.M1_demand.zeta_season[season].value;
}

// 3.4. Полный спрос lambda_{s,i}(h) для заданных условий.
// Возвращает { segment: Float64Array(nCells*24) }, индекс [i*24+h].
export function demandField({ cells, params, year, scenario, dayType, season }) {
  const weights = cellWeights(cells, params);
  const result = {};
  for (const s of SEGMENTS) {
    const Ds = segmentDemand(s, year, scenario, params);
    const m = dayMultiplier(s, dayType, params);
    const zeta = seasonMultiplier(season, params);
    const p = hourlyProfile(s, dayType, params);
    const w = weights[s];
    const arr = new Float64Array(cells.length * 24);
    const factor = Ds * m * zeta;
    for (let i = 0; i < cells.length; i++) {
      const wi = w[i];
      const base = i * 24;
      for (let h = 0; h < 24; h++) arr[base + h] = factor * wi * p[h];
    }
    result[s] = arr;
  }
  return result;
}
