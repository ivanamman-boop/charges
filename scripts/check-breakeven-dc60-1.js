// Разовая проверка формулы 9.5 (S*, U*) для DC60-1 на дефолтных параметрах
// раздела 11. См. docs/journal.md, запись от 2026-09-19. Позже логика
// войдёт в economics.js и в тест Т7 (сверка формулы с помесячным расчётом).
function crf(r, H) {
  const f = Math.pow(1 + r, H);
  return (r * f) / (f - 1);
}

function margin({ e, kappaE, t, v, f_acq, p_el, eta_ch }) {
  return e * kappaE * ((t / (1 + v)) * (1 - f_acq) - p_el / eta_ch);
}

function sessionDuration({ e, kappaE, P_post, P_veh, phi, kappaP, t0 }) {
  const pi = Math.min(P_post, P_veh) * phi * kappaP;
  return (e * kappaE) / pi + t0; // часы
}

const params = {
  e: 25,
  kappaE: 1,
  t: 23,
  v: 0.22,
  f_acq: 0.02,
  p_el: 10,
  eta_ch: 0.94,
  P_post: 60,
  P_veh: 100,
  phi: 0.7,
  kappaP: 1,
  t0: 5 / 60,
};

const m = margin(params);
const tau = sessionDuration(params);
console.log('маржа m_s (руб/сессия):', m.toFixed(1));
console.log('tau (мин):', (tau * 60).toFixed(1));

const C_eq = 1.6e6;
const C_site = 0.7e6;
const C_int = 0.1e6;
const r = 0.18;
const H = 10;
const CRF = crf(r, H);
console.log('CRF:', CRF.toFixed(4));

const rentMonth = 10000;
const c = 1;
const OPEX = rentMonth * 12 * c + 0.04 * C_eq + 60000;
console.log('OPEX_fix_year:', OPEX.toFixed(0));

function report(label, C_conn) {
  const CAPEX = C_eq + C_conn + C_site + C_int;
  const Sstar = (OPEX + CAPEX * CRF) / (365 * m);
  const Ustar = (Sstar * tau) / (24 * c);
  console.log(`${label}: C_conn=${C_conn} CAPEX=${(CAPEX / 1e6).toFixed(2)}M S*=${Sstar.toFixed(2)} U*=${(Ustar * 100).toFixed(1)}%`);
}

report('NPV_low (c_A=10000, дорогая граница)', 10000 * 60);
report('середина (c_A=7500)', 7500 * 60);
report('NPV_high (c_A=5000, дешёвая граница)', 5000 * 60);

// Гипотеза: линейная амортизация вместо дисконтированного аннуитета.
const CAPEX_mid = C_eq + 7500 * 60 + C_site + C_int;
const SstarLinear = (OPEX + CAPEX_mid / H) / (365 * m);
const UstarLinear = (SstarLinear * tau) / (24 * c);
console.log(`линейная амортизация (без r): S*=${SstarLinear.toFixed(2)} U*=${(UstarLinear * 100).toFixed(1)}%`);
