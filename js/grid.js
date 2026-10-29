// Модуль 5. Подключение к сети (спецификация, раздел 7). Чистые функции.

// 7.1. Свободная мощность центра питания R'_q, кВт.
// portfolioLoadKW - сумма P_req уже выбранных в портфеле станций на этом ЦП
// (0 для одиночного кандидата вне портфельного режима).
export function freeCenterCapacityKW({ center, portfolioLoadKW = 0, params }) {
  const m5 = params.M5_grid;
  const cosPhi = m5.cos_phi.value;
  const kRes = m5.k_res.value;
  const bPlan = center.bus_planned_kW ?? 0;
  const raw = 1000 * center.reserve_MVA * cosPhi - bPlan - portfolioLoadKW;
  return raw * (1 - kRes);
}

// Расстояние до ближайшей известной ТП 0.4 кВ (data/tp04.json), м - только
// если она ближе 200 м: это доказывает класс А. Более дальняя известная ТП
// ничего не доказывает (в OSM размечена лишь часть ТП города), поэтому
// тогда возвращаем null - класс "А|Б", считается консервативно как Б.
export function dist04FromKnownTp(lat, lon, tpPoints, maxM = 200) {
  const kLon = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (const [la, lo] of tpPoints) {
    const dy = (la - lat) * 111320;
    if (Math.abs(dy) > maxM) continue;
    const d = Math.hypot(dy, (lo - lon) * 111320 * kLon);
    if (d < best) best = d;
  }
  return best <= maxM ? Math.round(best) : null;
}

// 7.2. Класс подключения.
export function gridClass({ Preq, dist04Meters, RqFreeKW }) {
  if (RqFreeKW < Preq) return 'В';
  if (dist04Meters === null || dist04Meters === undefined) return 'А|Б';
  if (Preq <= 150 && dist04Meters <= 200) return 'А';
  return 'Б';
}

// Плата за подключение класса А, ₽ без НДС: [дешёвая, дорогая, середина].
export function classAConnRange(params) {
  const c = params.M5_grid.c_A_conn_rub;
  return { low: c.min, high: c.max, mid: c.value };
}

// Стоимость и срок присоединения, диапазон [дешёвая граница, дорогая граница].
// Класс В не оценивается (возвращает null).
export function connectionCostRange({ cls, Preq, dist04Meters, params }) {
  const m5 = params.M5_grid;
  if (cls === 'В') return null;

  const useClass = cls === 'А|Б' ? 'Б' : cls; // до уточнения dist04 считаем консервативно как Б (дороже)
  if (useClass === 'А') {
    // Плата в Москве считается по длине кабеля до ТП, а не за кВт: диапазон
    // по 4 реальным ТУ РСЗС на 150 кВт (params c_A_conn_rub).
    const { low, high, mid } = classAConnRange(params);
    return {
      cls,
      costLow: low,
      costHigh: high,
      costTyp: mid,
      monthsLow: m5.T_conn_months.A.min,
      monthsHigh: m5.T_conn_months.A.max,
    };
  }
  const cabExtra = m5.c_cab_rub_per_m.value * Math.max(0, (dist04Meters ?? 0) - 200);
  const cLow = m5.c_B_rub_per_kW.min;
  const cHigh = m5.c_B_rub_per_kW.max;
  return {
    cls,
    costLow: cLow * Preq + cabExtra,
    costHigh: cHigh * Preq + cabExtra,
    monthsLow: m5.T_conn_months.B.min,
    monthsHigh: m5.T_conn_months.B.max,
  };
}

// 7.3. Предел мощности для модуля 6.
export function availablePowerKW({ RqFreeKW, stayInClassA }) {
  return stayInClassA ? Math.min(150, RqFreeKW) : RqFreeKW;
}

// 7.5. Субсидия (переключатель, по умолчанию выключена).
export function equipmentSubsidy({ Pcap, posts, CeqRub, params, enabled }) {
  if (!enabled) return 0;
  const m5 = params.M5_grid.subsidy_equipment;
  if (!(Pcap >= m5.min_power_kW && posts >= m5.min_connectors)) return 0;
  const rate = posts >= 3 ? m5.rate_3plus_dc_rub_per_kW.value : m5.rate_2dc_rub_per_kW.value;
  return Math.min(rate * Pcap, m5.cap_share.value * CeqRub, m5.cap_rub.value);
}

export function connectionSubsidy({ Pcap, posts, Cconn, params, enabled }) {
  if (!enabled) return 0;
  const m5 = params.M5_grid.subsidy_connection;
  const eq = params.M5_grid.subsidy_equipment;
  if (!(Pcap >= eq.min_power_kW && posts >= eq.min_connectors)) return 0;
  return Math.min(m5.cap_share.value * Cconn, m5.cap_rub.value);
}

// Компенсация МФППиП (Москва): 50% платы за техприсоединение, если её внёс
// оператор, не больше 2 млн ₽, тремя платежами. Федеральная субсидия 7.5
// (equipmentSubsidy, connectionSubsidy) на Москву не распространяется.
export function mfppipCompensation({ connCostRub, params }) {
  const m = params.M5_grid.mfppip;
  if (!m) return 0;
  return Math.min(m.share.value * connCostRub, m.cap_rub.value);
}
