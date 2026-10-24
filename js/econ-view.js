// Экономика площадки для карты зон и паспорта: те же формулы модуля 7
// (economics.js, раздел 9), что и в подборе оборудования (equipment.js), но
// с ручками, которые нужны сайту: компенсация МФППиП, цена электроэнергии,
// спрос ниже или выше прогноза, граница цены подключения. Чистые функции.
// Пороги и статусы - как в презентации (слайд 21): окупаемость за норматив
// РСЗС 8 лет, доля такси 10% сессий.
import { SEGMENTS } from './demand.js';
import { capexRub, opexFixYearRub, marginPerSession, sessionDurationHours, monthlyCashFlow, npv, paybackMonths, interpolateAnchors, crf } from './economics.js';
import { mfppipCompensation } from './grid.js';

export const STATUS = {
  priority: { label: 'Первая очередь', short: 'Первая очередь', tone: 'priority' },
  now: { label: 'Вторая очередь', short: 'Вторая очередь', tone: 'now' },
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
// launchYear - год решения о станции: поток начинается с него (заявка на ТП,
// через срок ТП - пуск), спрос после 2030 держится на уровне 2030. Так
// экономика паспорта согласована со статусом зоны на карте выбранного года.
// network - NPV для сети РСЗС: из сессий станции вычитаются перешедшие со
// станций самой РСЗС (ownLossByCombo), новые и ушедшие от конкурентов остаются.
export function siteEconomics(e, { params, subsidy = false, pEl = null, demandMult = 1, connBound = 'high', connOverride = null, launchYear = 2026, network = false }) {
  if (!e?.connRange) return null;
  const p = pEl === null ? params : withPel(params, pEl);
  const m7 = p.M6_M7_equipment_economics;
  const conn = connOverride || connFor(e.connRange, connBound);
  const cfg = e.cfg;
  // МФППиП не уменьшает вложения сразу: компенсация приходит тремя
  // платежами в конце 1-го, 2-го и 3-го года (притоки денежного потока).
  const comp = subsidy ? mfppipCompensation({ connCostRub: conn.cost, params: p }) : 0;
  const capex = capexRub({ CeqRub: cfg.C_eq_rub, connCostRub: conn.cost, params: p });
  const opex = opexFixYearRub({ posts: cfg.posts, CeqRub: cfg.C_eq_rub, params: p });
  const years = e.years || [2026, 2030];
  const incr = (key) => {
    if (!network || !e.ownLossByCombo) return 1;
    const total = SEGMENTS.reduce((a, s) => a + e.sessionsByCombo[key][s], 0);
    return total > 0 ? Math.max(0, total - e.ownLossByCombo[key]) / total : 1;
  };
  const getSessions = (year, season, dayType, segment) =>
    demandMult * interpolateAnchors(Object.fromEntries(years.map((y) => [y, e.sessionsByCombo[`${y}|${season}|${dayType}`][segment] * incr(`${y}|${season}|${dayType}`)])), year);
  // Маржа летняя во всех месяцах - как в equipment.js (зимний расход учтён в сессиях).
  const CF = monthlyCashFlow({ getSessions, marginBySegmentSeason: (s) => marginPerSession({ segment: s, season: 'summer', params: p }), TconnMonths: conn.months, OPEXfixYearRub: opex, startYear: launchYear, H: m7.H_years.value, r: m7.r_discount_rate.value });
  const nInst = p.M5_grid.mfppip?.installments.value ?? 3;
  for (let k = 1; k <= nInst && comp > 0; k++) CF[12 * k - 1] += comp / nInst;
  const r = m7.r_discount_rate.value;
  return {
    capex,
    opex,
    subsidyRub: comp,
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

// Состав сессий для порогов карты: доля такси из params (10%, слайд 21).
export function thresholdMix(params) {
  const t = params.M6_M7_equipment_economics.threshold_taxi_share.value;
  return { P0: 1 - t, T: t };
}

// Пороги в зарядках в сутки для конфигурации cfg (из каталога, C_eq в млн ₽),
// как на слайде 21: pb - простая окупаемость за норматив РСЗС N = 8 лет,
// npv - окупаемость с дисконтом r = 18% за те же N лет (NPV за N лет = 0,
// через CRF). Установившийся режим: спрос держится на этом уровне все годы.
// subsidy - компенсация МФППиП: в простой окупаемости вычитается целиком,
// в дисконтированной - по приведённой стоимости трёх платежей.
// uPb/uNpv - те же пороги в загрузке поста.
export function thresholds({ params, cfg, connCostRub, mix = thresholdMix(params), subsidy = false }) {
  const m7 = params.M6_M7_equipment_economics;
  const CeqRub = cfg.C_eq_rub ?? cfg.C_eq_mln_rub * 1e6;
  const full = { ...cfg, C_eq_rub: CeqRub };
  const capex = capexRub({ CeqRub, connCostRub, params });
  const opex = opexFixYearRub({ posts: full.posts, CeqRub, params });
  const { margin, tau } = mixAverages({ mix, cfg: full, params });
  const N = m7.payback_norm_years.value;
  const r = m7.r_discount_rate.value;
  const comp = subsidy ? mfppipCompensation({ connCostRub, params }) : 0;
  const nInst = params.M5_grid.mfppip?.installments.value ?? 3;
  let pvComp = 0;
  for (let k = 1; k <= nInst; k++) pvComp += comp / nInst / Math.pow(1 + r, k);
  const pb = ((capex - comp) / N + opex) / (365 * margin);
  const npvS = (opex + (capex - pvComp) * crf(r, N)) / (365 * margin);
  const toU = (S) => (S * tau) / (24 * full.posts);
  return { pb, npv: npvS, uPb: toU(pb), uNpv: toU(npvS), tau, margin, capex, normYears: N };
}

// Загрузка поста: обслуженные сессии × их длительность по сегментам / (24 ч ×
// посты). combo - 'year|season|dayType' или null (средний день года).
const SEASON_W = { winter: 5 / 12, summer: 7 / 12 };
const DAY_W = { weekday: 5 / 7, weekend: 2 / 7 };
export function utilization(e, year, params, { season = null, dayType = null } = {}) {
  const st = { P_post_kW: e.cfg.P_post_kW };
  const one = (se, d) => SEGMENTS.reduce((a, s) => a + e.sessionsByCombo[`${year}|${se}|${d}`][s] * sessionDurationHours({ segment: s, station: st, season: se, params }), 0) / (24 * e.cfg.posts);
  if (season) return one(season, dayType);
  let u = 0;
  for (const se of ['winter', 'summer']) for (const d of ['weekday', 'weekend']) u += SEASON_W[se] * DAY_W[d] * one(se, d);
  return u;
}

export function taxiShare(e, year) {
  let t = 0;
  let all = 0;
  for (const se of ['winter', 'summer'])
    for (const d of ['weekday', 'weekend']) {
      const w = SEASON_W[se] * DAY_W[d];
      const seg = e.sessionsByCombo[`${year}|${se}|${d}`];
      t += w * seg.T;
      all += w * SEGMENTS.reduce((a, s) => a + seg[s], 0);
    }
  return all > 0 ? t / all : 0;
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
export function robustness(e, { params, subsidy = false, launchYear = 2026 }) {
  const base = params.M6_M7_equipment_economics.p_el_rub_per_kWh;
  const npvAt = (opts) => siteEconomics(e, { params, subsidy, launchYear, ...opts })?.npv ?? NaN;
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

// Метрики уровня 1 ТЗ по экономике площадки для года y (средний день года):
// средневзвешенная маржа m̄ по составу сегментов станции, годовой поток
// CF = 365 × N × m̄ − F, порог безубыточности S* = (F + CAPEX × CRF(r, H)) /
// (365 × m̄) (9.5), U* и запас прочности N / S*.
export function siteMetrics(e, year, { params, capex }) {
  const m7 = params.M6_M7_equipment_economics;
  const st = { P_post_kW: e.cfg.P_post_kW };
  let N = 0;
  let marginSum = 0;
  let tauSum = 0;
  for (const se of ['winter', 'summer'])
    for (const d of ['weekday', 'weekend']) {
      const w = SEASON_W[se] * DAY_W[d];
      for (const s of SEGMENTS) {
        const n = w * e.sessionsByCombo[`${year}|${se}|${d}`][s];
        N += n;
        // Маржа зимой с учётом расхода ×κ_E (9.2).
        marginSum += n * marginPerSession({ segment: s, season: se, params });
        tauSum += n * sessionDurationHours({ segment: s, station: st, season: se, params });
      }
    }
  const mBar = N > 0 ? marginSum / N : 0;
  const tau = N > 0 ? tauSum / N : 0;
  const F = opexFixYearRub({ posts: e.cfg.posts, CeqRub: e.cfg.C_eq_rub, params });
  const Sstar = mBar > 0 ? (F + capex * crf(m7.r_discount_rate.value, m7.H_years.value)) / (365 * mBar) : Infinity;
  return { N, mBar, tau, F, cfYear: 365 * N * mBar - F, Sstar, Ustar: (Sstar * tau) / (24 * e.cfg.posts), margin: N / Sstar };
}

// Вердикт ТЗ: «Строить» - NPV при дорогом подключении > 0 и простая
// окупаемость не дольше норматива; «Запросить ТУ» - NPV > 0 только при
// дешёвом подключении; иначе «Не строить».
export function verdictRszs({ npvExpensive, npvCheap, paybackExpensive, normYears }) {
  if (npvExpensive > 0 && paybackExpensive !== null && paybackExpensive <= normYears) return 'build';
  if (npvCheap > 0) return 'request';
  return 'no';
}
export const VERDICT = {
  build: { label: 'Строить', tone: 'now' },
  request: { label: 'Запросить ТУ у сети', tone: 'grid' },
  no: { label: 'Не строить', tone: 'no' },
};
