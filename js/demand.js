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
    g = scenario === 'conservative' ? d1.g_taxi.conservative.value : d1.g_taxi.base_and_optimistic.value;
  } else {
    g = d1.g_private[scenario].value;
  }
  return theta * D0 * Math.pow(1 + g, year - Y0);
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
