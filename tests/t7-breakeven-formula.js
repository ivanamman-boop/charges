// Т7. Формула U* (спецификация, раздел 13, 9.5). Критерий в самой
// спецификации не задан числом ("Критерий" пусто в таблице раздела 13),
// поэтому проверяем рационально: подставляем постоянный спрос S* в
// помесячный расчёт с T^conn = 0 и сравниваем NPV не с нулём "в лоб", а с
// аналитически предсказанным расхождением.
//
// Расхождение и его причина (см. docs/journal.md, запись от 20.09): S*
// определяется закрытой формулой так, что net = OPEXfixYear... на самом
// деле net = CAPEX*CRF ровно (годовой аннуитет, платёж в конце года). Но
// помесячный расчёт (раздел 9.3) размазывает тот же net равномерно по 12
// месяцам, а не платит его лампсамом в конце года — деньги в среднем
// приходят раньше, поэтому NPV(S*) > 0, а не 0. Эффект считается точно:
// сравниваем годовой лампсам (аналитический ноль по построению CRF) с тем
// же net, размазанным помесячно, и ожидаем, что реальный помесячный расчёт
// совпадёт с этим предсказанием почти точно (это чистая арифметика
// дисконтирования, не зависящая от реализации).
import { readFileSync } from 'node:fs';
import { marginPerSession, sessionDurationHours, capexRub, opexFixYearRub, breakeven, monthlyCashFlow, npv, crf } from '../js/economics.js';

const params = JSON.parse(readFileSync(new URL('../data/params.json', import.meta.url)));

const SEGMENT = 'P0';
const SEASON = 'summer'; // маржа считается сезонно-неизменной для этого теста - так же, как её трактует закрытая формула (один m̄)
const station = { P_post_kW: 60 };
const posts = 1;
const CeqRub = 1.6e6; // DC60-1, раздел 8.1
const connCostRub = 600000; // произвольная фиксированная стоимость присоединения для теста

const marginBar = marginPerSession({ segment: SEGMENT, season: SEASON, params });
const tauBar = sessionDurationHours({ segment: SEGMENT, station, season: SEASON, params });
const CAPEXrub = capexRub({ CeqRub, connCostRub, params });
const OPEXfixYearRub = opexFixYearRub({ posts, CeqRub, params });

const { Sstar, Ustar, CRF } = breakeven({ OPEXfixYearRub, CAPEXrub, marginBar, tauBarHours: tauBar, posts, params });

console.log('margin (руб/сессия):', marginBar.toFixed(2));
console.log('tau (мин):', (tauBar * 60).toFixed(1));
console.log('CAPEX:', (CAPEXrub / 1e6).toFixed(2), 'млн ₽, OPEX/год:', OPEXfixYearRub.toFixed(0));
console.log('S* =', Sstar.toFixed(3), 'сессий/сутки, U* =', (Ustar * 100).toFixed(2) + '%');

const H = params.M6_M7_equipment_economics.H_years.value;
const r = params.M6_M7_equipment_economics.r_discount_rate.value;

// --- реальный помесячный расчёт (раздел 9.3), тот же S* каждый день ---
const getSessions = (year, season, dayType, segment) => (segment === SEGMENT ? Sstar : 0);
const marginBySegmentSeason = (segment) => (segment === SEGMENT ? marginBar : 0);
const CF = monthlyCashFlow({ getSessions, marginBySegmentSeason, TconnMonths: 0, OPEXfixYearRub, startYear: 2026, H, r });
const NPVactual = npv(CF, CAPEXrub, r);

// --- аналитическое предсказание того же расхождения (чистая арифметика) ---
const netAnnual = CAPEXrub * CRF; // по построению S*: (revenue-opex) за год = CAPEX*CRF
let NPVpredicted = -CAPEXrub;
for (let t = 1; t <= 12 * H; t++) NPVpredicted += netAnnual / 12 / Math.pow(1 + r, t / 12);

console.log('NPV помесячного расчёта:', NPVactual.toFixed(0), '₽');
console.log('NPV, предсказанный аналитически (эффект размазывания):', NPVpredicted.toFixed(0), '₽');

const residual = Math.abs(NPVactual - NPVpredicted);
const tolerance = 0.005 * CAPEXrub; // 0.5% CAPEX - на календарные допущения (5/2 буд/вых в среднем месяце)
console.log('расхождение факт/прогноз:', residual.toFixed(0), '₽ (допуск ±' + tolerance.toFixed(0) + ')');

const pass = residual < tolerance;
console.log(pass ? 'Т7: ПРОЙДЕН' : 'Т7: ПРОВАЛЕН');
if (!pass) process.exit(1);
