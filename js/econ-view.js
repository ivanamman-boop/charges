// Экономика площадки для карты зон и паспорта: те же формулы модуля 7
// (economics.js, раздел 9), что и в подборе оборудования (equipment.js), но
// с ручками, которые нужны сайту: субсидия, цена электроэнергии, спрос ниже
// или выше прогноза, граница цены подключения. Чистые функции.
import { SEGMENTS } from './demand.js';
import { capexRub, opexFixYearRub, marginPerSession, sessionDurationHours, monthlyCashFlow, npv, paybackMonths, interpolateAnchors, crf } from './economics.js';
import { equipmentSubsidy, connectionSubsidy } from './grid.js';

export const STATUS = {
  priority: { label: 'Ставить, приоритет', short: 'Приоритет', tone: 'priority' },
  now: { label: 'Ставить сейчас', short: 'Ставить сейчас', tone: 'now' },
  grid: { label: 'Готовить сеть', short: 'Готовить сеть', tone: 'grid' },
  no: { label: 'Не ставить', short: 'Не ставить', tone: 'no' },
};

const withPel = (params, pEl) => ({
  ...params,
  M6_M7_equipment_economics: { ...params.M6_M7_equipment_economics, p_el_rub_per_kWh: { ...params.M6_M7_equipment_economics.p_el_rub_per_kWh, value: pEl } },
});

function connFor(connRange, bound) {
  if (bound === 'low') return { cost: connRange.costLow, months: connRange.monthsLow };
  if (bound === 'mid') return { cost: (connRange.costLow + connRange.costHigh) / 2, months: (connRange.monthsLow + connRange.monthsHigh) / 2 };
  return { cost: connRange.costHigh, months: connRange.monthsHigh };
}

// Экономика одной оценённой конфигурации e (результат equipment.js:
// sessionsByCombo, cfg, connRange). connBound: 'high' - дорогая граница
// подключения (осторожно, как в модуле 8), 'low' - дешёвая, 'mid' - середина.
// connOverride - подставить стоимость/срок другого класса (чувствительность).
export function siteEconomics(e, { params, subsidy = false, pEl = null, demandMult = 1, connBound = 'high', connOverride = null }) {
  if (!e?.connRange) return null;
  const p = pEl === null ? params : withPel(params, pEl);
  const m7 = p.M6_M7_equipment_economics;
  const conn = connOverride || connFor(e.connRange, connBound);
  const cfg = e.cfg;
  const subEq = equipmentSubsidy({ Pcap: cfg.P_cap_kW, posts: cfg.posts, CeqRub: cfg.C_eq_rub, params: p, enabled: subsidy });
  const subConn = connectionSubsidy({ Pcap: cfg.P_cap_kW, posts: cfg.posts, Cconn: conn.cost, params: p, enabled: subsidy });
  const capex = capexRub({ CeqRub: cfg.C_eq_rub, connCostRub: conn.cost, subsidyEqRub: subEq, subsidyConnRub: subConn, params: p });
  const opex = opexFixYearRub({ posts: cfg.posts, CeqRub: cfg.C_eq_rub, params: p });
  const years = e.years || [2026, 2030];
  const getSessions = (year, season, dayType, segment) =>
    demandMult * interpolateAnchors(Object.fromEntries(years.map((y) => [y, e.sessionsByCombo[`${y}|${season}|${dayType}`][segment]])), year);
  // Маржа летняя во всех месяцах - как в equipment.js (зимний расход учтён в сессиях).
  const CF = monthlyCashFlow({ getSessions, marginBySegmentSeason: (s) => marginPerSession({ segment: s, season: 'summer', params: p }), TconnMonths: conn.months, OPEXfixYearRub: opex, startYear: 2026, H: m7.H_years.value, r: m7.r_discount_rate.value });
  const r = m7.r_discount_rate.value;
  return {
    capex,
    opex,
    subsidyRub: subEq + subConn,
    npv: npv(CF, capex, r),
    payback: paybackMonths(CF, capex, false, r),
    paybackDisc: paybackMonths(CF, capex, true, r),
    connMonths: conn.months,
    connCost: conn.cost,
  };
}

// Средняя маржа и длительность сессии при составе сегментов mix ({P0: w, ...}).
function mixAverages({ mix, cfg, params }) {
  const total = SEGMENTS.reduce((a, s) => a + (mix[s] || 0), 0) || 1;
  let margin = 0;
  let tau = 0;
  for (const s of SEGMENTS) {
    const w = (mix[s] || 0) / total;
    margin += w * marginPerSession({ segment: s, season: 'summer', params });
    tau += w * sessionDurationHours({ segment: s, station: { P_post_kW: cfg.P_post_kW }, season: 'summer', params });
  }
  return { margin, tau };
}

// Пороги в зарядках в сутки для конфигурации cfg (из каталога, C_eq в млн ₽):
// pb - простая окупаемость за срок службы H (10 лет), npv - NPV = 0 при
// ставке r (9.5, через CRF). Установившийся режим: если бы спрос держался на
// этом уровне все годы. uPb/uNpv - те же пороги в загрузке поста.
export function thresholds({ params, cfg, connCostRub, mix, subsidy = false }) {
  const m7 = params.M6_M7_equipment_economics;
  const CeqRub = cfg.C_eq_rub ?? cfg.C_eq_mln_rub * 1e6;
  const full = { ...cfg, C_eq_rub: CeqRub };
  const subEq = equipmentSubsidy({ Pcap: full.P_cap_kW, posts: full.posts, CeqRub, params, enabled: subsidy });
  const subConn = connectionSubsidy({ Pcap: full.P_cap_kW, posts: full.posts, Cconn: connCostRub, params, enabled: subsidy });
  const capex = capexRub({ CeqRub, connCostRub, subsidyEqRub: subEq, subsidyConnRub: subConn, params });
  const opex = opexFixYearRub({ posts: full.posts, CeqRub, params });
  const { margin, tau } = mixAverages({ mix, cfg: full, params });
  const H = m7.H_years.value;
  const pb = (capex / H + opex) / (365 * margin);
  const npvS = (opex + capex * crf(m7.r_discount_rate.value, H)) / (365 * margin);
  const toU = (S) => (S * tau) / (24 * full.posts);
  return { pb, npv: npvS, uPb: toU(pb), uNpv: toU(npvS), tau, margin, capex };
}

export const loadFromSessions = (S, th, posts) => (S * th.tau) / (24 * posts);

// Статус места в году: класс подключения + прогноз против порогов класса А.
// «Готовить сеть» - спрос окупил бы станцию с дешёвым подключением, но
// известной ТП 0.4 кВ рядом нет (класс Б или нет данных).
export function siteStatus({ S, cls, th }) {
  if (cls === 'В' || S === null || S === undefined) return 'no';
  if (S >= th.pb && cls === 'А') return S >= th.npv ? 'priority' : 'now';
  if (S >= th.pb) return 'grid';
  return 'no';
}

// Значение ручки, при котором NPV переходит через ноль (бисекция).
// f(x) - NPV при значении x, монотонная на [lo, hi]. null - ноль вне диапазона.
function crossing(f, lo, hi) {
  let flo = f(lo);
  const fhi = f(hi);
  if (Math.sign(flo) === Math.sign(fhi)) return null;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = mid;
      flo = fm;
    } else hi = mid;
  }
  return (lo + hi) / 2;
}

// Устойчивость вывода (паспорт): при какой цене электроэнергии и при каком
// отклонении спроса от прогноза NPV станции становится нулевым.
export function robustness(e, { params, subsidy = false }) {
  const base = params.M6_M7_equipment_economics.p_el_rub_per_kWh;
  const npvAt = (opts) => siteEconomics(e, { params, subsidy, ...opts })?.npv ?? NaN;
  const pElZero = crossing((x) => npvAt({ pEl: x }), 0, 40);
  const demandZero = crossing((x) => npvAt({ demandMult: x }), 0.05, 5);
  return {
    pElBase: base.value,
    pElRange: [base.min, base.max],
    pElZero,
    pElZeroPct: pElZero === null ? null : pElZero / base.value - 1,
    demandZeroPct: demandZero === null ? null : demandZero - 1,
    npvAtPelMax: npvAt({ pEl: base.max }),
  };
}
