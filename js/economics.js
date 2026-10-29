// Модуль 7. Экономика (спецификация, раздел 9). Чистые функции.
import { SEGMENTS } from './demand.js';
import { sessionMetrics as queueSessionMetrics } from './queue.js';

const SEGMENT_E_GROUP = { P0: 'P0_P1_C', P1: 'P0_P1_C', C: 'P0_P1_C', T: 'T' };
const SEGMENT_VEH_GROUP = { P0: 'P_C', P1: 'P_C', C: 'P_C', T: 'T' };

// 9.2. Маржа с одной сессии сегмента s, руб.
export function marginPerSession({ segment, season, params }) {
  const m7 = params.M6_M7_equipment_economics;
  const m3 = params.M3_queue;
  const kappaE = season === 'winter' ? m3.kappa_winter.E.value : 1;
  const e = m3.e_kWh[SEGMENT_E_GROUP[segment]].value;
  const t = segment === 'T' ? m7.tariff_incl_vat_rub_per_kWh.taxi.value : m7.tariff_incl_vat_rub_per_kWh.retail_and_corporate.value;
  const v = m7.vat_rate.value;
  const fAcq = m7.f_acq.value;
  const pEl = m7.p_el_rub_per_kWh.value;
  const etaCh = m7.eta_ch.value;
  return e * kappaE * ((t / (1 + v)) * (1 - fAcq) - pEl / etaCh);
}

// 5.1. tau сегмента на станции (для U* и помесячного расчёта).
export function sessionDurationHours({ segment, station, season, params }) {
  const m3 = params.M3_queue;
  const kappaE = season === 'winter' ? m3.kappa_winter.E.value : 1;
  const kappaP = season === 'winter' ? m3.kappa_winter.P.value : 1;
  const e = m3.e_kWh[SEGMENT_E_GROUP[segment]].value;
  const pVeh = m3.P_veh_kW[SEGMENT_VEH_GROUP[segment]].value;
  const phi = m3.phi.value;
  const t0 = m3.t0_min.value / 60;
  return queueSessionMetrics({ P_post: station.P_post_kW, P_veh: pVeh, phi, kappaP, e, kappaE, t0 }).tau;
}

export function crf(r, H) {
  const f = Math.pow(1 + r, H);
  return (r * f) / (f - 1);
}

// 9.1. CAPEX = оборудование + присоединение + площадка + интеграция + балансировка - субсидии.
export function capexRub({ CeqRub, connCostRub, CbalRub = 0, subsidyEqRub = 0, subsidyConnRub = 0, params }) {
  const m7 = params.M6_M7_equipment_economics;
  const Csite = m7.C_site_mln_rub.value * 1e6;
  const Cint = m7.C_int_mln_rub.value * 1e6;
  return CeqRub + connCostRub + Csite + Cint + CbalRub - subsidyEqRub - subsidyConnRub;
}

// OPEX^fix в год: аренда мест + обслуживание (доля C^eq) + связь и страховка.
export function opexFixYearRub({ posts, CeqRub, params }) {
  const m7 = params.M6_M7_equipment_economics;
  const rent = m7.rent_rub_per_place_month.value * 12 * posts;
  const maintenance = m7.maintenance_share_Ceq_per_year.value * CeqRub;
  // контакт-центр, сервис, ПО: РСЗС 29.10 - постоянные расходы «кратно больше»
  const other = m7.opex_other_rub_per_year?.value ?? 0;
  return rent + maintenance + m7.connectivity_insurance_rub_per_year.value + other;
}

// Замена оборудования: каждые L лет (РСЗС 29.10: через 5 лет ЭЗС устаревает)
// оборудование покупается заново. Месяцы покупки внутри горизонта H лет
// (покупка в самом конце горизонта не нужна).
export function reinvestMonths(params, H) {
  const L = params.M6_M7_equipment_economics.equipment_life_years?.value;
  if (!L) return [];
  const out = [];
  for (let k = 1; 12 * L * k < 12 * H; k++) out.push(12 * L * k);
  return out;
}

// Сумма замен оборудования за первые N лет: простая (pv=false) или приведённая.
export function reinvestWithin(params, CeqRub, N, r = 0) {
  return reinvestMonths(params, N).reduce((a, m) => a + CeqRub / Math.pow(1 + r, m / 12), 0);
}

const WINTER_MONTHS = new Set([11, 12, 1, 2, 3]); // 3.4: зима считается 5 месяцев, ноябрь-март
const DAYS_PER_MONTH_AVG = 365.25 / 12;
const WEEKDAY_DAYS_PER_MONTH = (DAYS_PER_MONTH_AVG * 5) / 7;
const WEEKEND_DAYS_PER_MONTH = (DAYS_PER_MONTH_AVG * 2) / 7;

function seasonForCalendarMonth(monthOfYear) {
  return WINTER_MONTHS.has(monthOfYear) ? 'winter' : 'summer';
}

// Геометрическая интерполяция S(y) между опорными 2026/2030, после 2030 - на
// уровне 2030 (9.3, формула интерполяции). sessionsByYear: {2026: v, 2030: v}.
export function interpolateSessions(sessionsByYear, year) {
  return interpolateAnchors(sessionsByYear, year);
}

// То же для любого набора опорных лет ({2026: v, 2028: v, 2030: v}):
// геометрически между соседними опорными годами, за краями - крайнее
// значение. Средний опорный год нужен, потому что городские станции
// открываются в 2027-2030: между 2026 и 2030 сессии станции не растут
// гладко, и интерполяция только по краям завышала 2028 почти вдвое
// (journal.md, 21.10).
export function interpolateAnchors(byYear, year) {
  const ys = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  if (year <= ys[0]) return byYear[ys[0]];
  if (year >= ys[ys.length - 1]) return byYear[ys[ys.length - 1]];
  for (let i = 0; i < ys.length - 1; i++) {
    const a = ys[i];
    const b = ys[i + 1];
    if (year > b) continue;
    const sa = byYear[a];
    const sb = byYear[b];
    if (sa <= 0) return sa; // избегаем 0^x / деления
    return sa * Math.pow(sb / sa, (year - a) / (b - a));
  }
  return byYear[ys[ys.length - 1]];
}

// 9.3-9.4. Помесячный денежный поток и производные показатели.
// getSessions(year, season, dayType, segment) -> сессий/сутки для этого сегмента.
export function monthlyCashFlow({ getSessions, marginBySegmentSeason, TconnMonths, OPEXfixYearRub, startYear = 2026, H, r, reinvest = null }) {
  const CF = new Array(12 * H).fill(0);
  for (let t = 1; t <= 12 * H; t++) {
    if (t <= TconnMonths) continue; // 1[t > Tconn]
    const monthIndex0 = t - 1;
    const monthOfYear = (monthIndex0 % 12) + 1;
    const year = startYear + Math.floor(monthIndex0 / 12);
    const season = seasonForCalendarMonth(monthOfYear);

    let revenue = 0;
    for (const dayType of ['weekday', 'weekend']) {
      const nDays = dayType === 'weekday' ? WEEKDAY_DAYS_PER_MONTH : WEEKEND_DAYS_PER_MONTH;
      for (const s of SEGMENTS) {
        const sessions = getSessions(year, season, dayType, s);
        revenue += nDays * sessions * marginBySegmentSeason(s, season);
      }
    }
    CF[t - 1] = revenue - OPEXfixYearRub / 12;
  }
  // reinvest = {rub, months}: покупка оборудования заново (замена через L лет)
  if (reinvest) for (const m of reinvest.months) if (m >= 1 && m <= CF.length) CF[m - 1] -= reinvest.rub;
  return CF;
}

// 9.4. NPV = -CAPEX + Σ CF_t / (1+r)^(t/12), r - годовая ставка (9.4).
export function npv(CF, capex, r) {
  return -capex + CF.reduce((acc, cf, i) => acc + cf / Math.pow(1 + r, (i + 1) / 12), 0);
}

// Окупаемость: месяц, с которого накопленный поток покрывает вложения и
// больше не проваливается ниже (замена оборудования через L лет может снова
// увести станцию в минус - тогда окупаемость считается после неё).
export function paybackMonths(CF, capex, discounted, r) {
  let cum = 0;
  let lastBelow = 0;
  for (let t = 1; t <= CF.length; t++) {
    const cf = discounted ? CF[t - 1] / Math.pow(1 + r, t / 12) : CF[t - 1];
    cum += cf;
    if (cum < capex) lastBelow = t;
  }
  if (cum < capex) return null; // не окупилось за горизонт H
  return (lastBelow + 1) / 12;
}

// 9.5. Загрузка безубыточности (закрытая формула).
export function breakeven({ OPEXfixYearRub, CAPEXrub, marginBar, tauBarHours, posts, params }) {
  const m7 = params.M6_M7_equipment_economics;
  const CRFval = crf(m7.r_discount_rate.value, m7.H_years.value);
  const Sstar = (OPEXfixYearRub + CAPEXrub * CRFval) / (365 * marginBar);
  const Ustar = (Sstar * tauBarHours) / (24 * posts);
  return { Sstar, Ustar, CRF: CRFval };
}
