// Модуль 6. Подбор оборудования (спецификация, раздел 8). Чистые функции.
import { SEGMENTS } from './demand.js';
import { localEquilibrium, dailySessions } from './equilibrium.js';
import { haversineKm } from './choice.js';
import { freeCenterCapacityKW, gridClass, connectionCostRange, availablePowerKW, equipmentSubsidy, connectionSubsidy } from './grid.js';
import { capexRub, opexFixYearRub, marginPerSession, sessionDurationHours, monthlyCashFlow, npv, paybackMonths, interpolateSessions, breakeven } from './economics.js';

const YEARS = [2026, 2030];
const SEASONS = ['winter', 'summer'];
const DAY_TYPES = ['weekday', 'weekend'];
const HARDEST_CASE = { year: 2030, season: 'winter', dayType: 'weekday' }; // 8.2: самый тяжёлый случай для Acc

function nearestCenter(lat, lon, centers) {
  let best = null;
  let bestD = Infinity;
  for (const c of centers) {
    const d = haversineKm(lat, lon, c.lat, c.lon);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

// Каталог配置 -> кандидатные конфигурации (8.1) с учётом предела мощности.
// bal-вариант создаётся только если известна стоимость системы балансировки
// (params.M6_M7_equipment_economics.catalog не даёт c_bal - в спецификации
// "параметр без дефолта, источника мы не нашли"; -bal варианты помечаются
// costUnknown и исключаются из выбора omega*, но остаются в списке для UI).
export function candidateConfigs({ PavailKW, params }) {
  const catalog = params.M6_M7_equipment_economics.catalog.configs;
  const result = [];
  for (const cfg of catalog) {
    if (cfg.P_cap_kW <= PavailKW) {
      result.push({ omega: cfg.omega, P_cap_kW: cfg.P_cap_kW, posts: cfg.posts, P_post_kW: cfg.P_post_kW, C_eq_rub: cfg.C_eq_mln_rub * 1e6, isBal: false, costUnknown: false });
    } else if (PavailKW > 0) {
      // базовая конфигурация не влезает по мощности - добавляем bal-вариант
      result.push({
        omega: `${cfg.omega}-bal`,
        P_cap_kW: PavailKW,
        posts: cfg.posts,
        P_post_kW: cfg.P_post_kW,
        C_eq_rub: cfg.C_eq_mln_rub * 1e6,
        isBal: true,
        costUnknown: true, // c_bal без дефолта (раздел 8.1) - NPV не считаем
      });
    }
  }
  return result;
}

// Оценка одной конфигурации: 8 локальных равновесий (2 года x 2 сезона x 2
// типа дня), экономика с диапазоном присоединения, ограничение по Acc.
// Генератор: отдаёт управление после каждого локального равновесия, чтобы
// браузер мог обновить полосу загрузки паспорта (evaluateCandidateAsync);
// синхронная evaluateCandidate просто прогоняет его до конца.
function* evaluateConfigSteps({ cfg, candidateBase, cells, params, getBaseline, centerFree, dist04Meters }) {
  const sessionsByCombo = {}; // "year|season|dayType" -> {segment: S}
  // Новый для сети спрос (6.3): сколько сессий/сутки кандидат обслуживает
  // сверх того, что сеть обслуживала без него = −(ΔΛ_out + ΔΛ_lost).
  const netGainByCombo = {};
  let minAcc = 1;
  let worstHourAcc = null;
  // Худшая доступность в самый тяжёлый режим (зима, будни) по годам - для
  // выбора оборудования без экономики: что достаточно сейчас и к 2030.
  const minAccByYear = { 2026: 1, 2030: 1 };
  // Доступность за сутки, взвешенная по приехавшим (тот же режим): какую
  // долю своих клиентов станция принимает без отказа и долгого ожидания.
  // Худший час (minAcc) слишком строг для выбора оборудования: в пиковый
  // час 90% не держит ни одна конфигурация каталога - чем мощнее станция,
  // тем больше клиентов она перетягивает и тем длиннее её пиковая очередь.
  const accDayByYear = { 2026: 1, 2030: 1 };

  for (const year of YEARS) {
    for (const season of SEASONS) {
      for (const dayType of DAY_TYPES) {
        const { context, result: fullResult, stations } = getBaseline(year, season, dayType);
        const candidate = { ...candidateBase, P_kW: cfg.P_cap_kW, posts: cfg.posts, P_post_kW: cfg.P_post_kW, year_open: year };
        const local = localEquilibrium({ cells, stations, candidate, params, year, scenario: 'base', dayType, season, fullContext: context, fullResult });
        const idx = local.candidateLocalIdx;

        const perSegment = {};
        for (const s of SEGMENTS) {
          let sum = 0;
          for (let h = 0; h < 24; h++) sum += local.combined.bySegment[s][idx * 24 + h] * (1 - local.qh.L[idx * 24 + h]);
          perSegment[s] = sum;
        }
        sessionsByCombo[`${year}|${season}|${dayType}`] = perSegment;
        netGainByCombo[`${year}|${season}|${dayType}`] = -(local.deltaLambdaOut + local.deltaLambdaLost);
        if (season === HARDEST_CASE.season && dayType === HARDEST_CASE.dayType) {
          let arrSum = 0;
          let accSum = 0;
          for (let h = 0; h < 24; h++) {
            const k = idx * 24 + h;
            minAccByYear[year] = Math.min(minAccByYear[year], local.qh.Acc[k]);
            let arr = 0;
            for (const s of SEGMENTS) arr += local.combined.bySegment[s][k];
            arrSum += arr;
            accSum += arr * local.qh.Acc[k];
          }
          accDayByYear[year] = arrSum > 0 ? accSum / arrSum : 1;
        }

        if (year === HARDEST_CASE.year && season === HARDEST_CASE.season && dayType === HARDEST_CASE.dayType) {
          for (let h = 0; h < 24; h++) {
            const acc = local.qh.Acc[idx * 24 + h];
            if (acc < minAcc) {
              minAcc = acc;
              worstHourAcc = h;
            }
          }
        }
        yield;
      }
    }
  }

  const Preq = cfg.P_cap_kW;
  const cls = gridClass({ Preq, dist04Meters, RqFreeKW: centerFree });
  const connRange = connectionCostRange({ cls, Preq, dist04Meters, params });

  const getSessions = (year, season, dayType, segment) => {
    const s26 = sessionsByCombo[`2026|${season}|${dayType}`][segment];
    const s30 = sessionsByCombo[`2030|${season}|${dayType}`][segment];
    return interpolateSessions({ 2026: s26, 2030: s30 }, year);
  };
  const marginBySegmentSeason = (segment, season) => marginPerSession({ segment, season, params });

  const m7 = params.M6_M7_equipment_economics;
  const H = m7.H_years.value;
  const r = m7.r_discount_rate.value;
  const OPEXfixYearRub = opexFixYearRub({ posts: cfg.posts, CeqRub: cfg.C_eq_rub, params });

  let scenarios = null;
  if (connRange && !cfg.costUnknown) {
    const subEq = equipmentSubsidy({ Pcap: cfg.P_cap_kW, posts: cfg.posts, CeqRub: cfg.C_eq_rub, params, enabled: false });
    const buildScenario = (connCostRub, TconnMonths) => {
      const subConn = connectionSubsidy({ Pcap: cfg.P_cap_kW, posts: cfg.posts, Cconn: connCostRub, params, enabled: false });
      const CAPEXrub = capexRub({ CeqRub: cfg.C_eq_rub, connCostRub, subsidyEqRub: subEq, subsidyConnRub: subConn, params });
      const CF = monthlyCashFlow({ getSessions, marginBySegmentSeason: (s) => marginBySegmentSeason(s, 'summer'), TconnMonths, OPEXfixYearRub, startYear: 2026, H, r });
      const NPVrub = npv(CF, CAPEXrub, r);
      const Tpb = paybackMonths(CF, CAPEXrub, false, r);
      const TpbDisc = paybackMonths(CF, CAPEXrub, true, r);
      return { CAPEXrub, NPVrub, Tpb, TpbDisc };
    };
    // NPV_low - дорогая граница присоединения (пессимистично), NPV_high - дешёвая.
    scenarios = {
      low: buildScenario(connRange.costHigh, connRange.monthsHigh),
      high: buildScenario(connRange.costLow, connRange.monthsLow),
    };
  }

  // S*/U* по замыкающей формуле (9.5), для сравнения с прогнозной U в паспорте.
  const station = { P_post_kW: cfg.P_post_kW };
  let breakevenInfo = null;
  if (connRange) {
    const marginBar = marginPerSession({ segment: 'P0', season: 'summer', params }); // упрощение: сегментный состав станции не усредняем отдельно
    const tauBar = sessionDurationHours({ segment: 'P0', station, season: 'summer', params });
    const capexMid = capexRub({ CeqRub: cfg.C_eq_rub, connCostRub: (connRange.costLow + connRange.costHigh) / 2, params });
    breakevenInfo = breakeven({ OPEXfixYearRub, CAPEXrub: capexMid, marginBar, tauBarHours: tauBar, posts: cfg.posts, params });
  }

  return { cfg, cls, connRange, scenarios, minAcc, worstHourAcc, minAccByYear, accDayByYear, breakevenInfo, sessionsByCombo, netGainByCombo };
}

function runToEnd(gen) {
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

// Средний день года (сезоны 5/12 зима + 7/12 лето, 5/7 будни + 2/7 выходные):
// всего сессий и новых для сети сессий в сутки для года 2026 или 2030.
const SEASON_W = { winter: 5 / 12, summer: 7 / 12 };
const DAY_W = { weekday: 5 / 7, weekend: 2 / 7 };
export function yearAverage(e, year) {
  let sessions = 0;
  let gain = 0;
  for (const season of SEASONS)
    for (const dayType of DAY_TYPES) {
      const w = SEASON_W[season] * DAY_W[dayType];
      const key = `${year}|${season}|${dayType}`;
      sessions += w * Object.values(e.sessionsByCombo[key]).reduce((a, b) => a + b, 0);
      gain += w * e.netGainByCombo[key];
    }
  return { sessions, gain };
}

// Оборудование без тарифов (решение команды 24.09 - экономику считают
// отдельно по выбранной точке, но стоимость подключения - фактор выбора):
// рекомендуем вариант с наибольшим числом НОВЫХ для сети клиентов (среднее
// 2026 и 2030) на 1 млн ₽ вложений - оборудование + присоединение +
// площадка, дорогая граница класса. Правило "самая компактная, что держит
// Acc >= alpha" не годится: в равновесии мощная станция перетягивает больше
// клиентов и её очередь снова растёт - 90% за сутки в зимний будний день не
// держит почти ни одна конфигурация. Класс В (нет резерва на ЦП) исключён.
export function newClientsPerMln(e) {
  const capex = e.scenarios?.low.CAPEXrub;
  return capex ? (yearAverage(e, 2026).gain + yearAverage(e, 2030).gain) / 2 / (capex / 1e6) : -Infinity;
}
function recommendConfig(evaluated) {
  const feasible = evaluated.filter((e) => e.cls !== 'В' && !e.cfg.isBal && e.scenarios);
  if (!feasible.length) return null;
  return feasible.reduce((best, e) => (newClientsPerMln(e) > newClientsPerMln(best) ? e : best));
}

// 8.2. Полная оценка кандидата: перебор конфигураций, выбор omega*, вердикт.
export function evaluateCandidate({ candidateBase, cells, centers, params, getBaseline, dist04Meters = null, stayInClassA = false }) {
  const center = nearestCenter(candidateBase.lat, candidateBase.lon, centers);
  const centerFree = freeCenterCapacityKW({ center, portfolioLoadKW: 0, params });
  const PavailKW = availablePowerKW({ RqFreeKW: centerFree, stayInClassA });

  const configs = candidateConfigs({ PavailKW, params });
  const evaluated = configs.map((cfg) =>
    runToEnd(evaluateConfigSteps({ cfg, candidateBase, cells, params, getBaseline, centerFree, dist04Meters }))
  );
  return finishCandidate({ center, centerFree, PavailKW, evaluated, params });
}

// То же, что evaluateCandidate, но асинхронно: после каждого локального
// равновесия вызывает onProgress(done, total) и отдаёт управление браузеру -
// полоса загрузки паспорта двигается, а страница не выглядит зависшей.
export async function evaluateCandidateAsync({ candidateBase, cells, centers, params, getBaseline, dist04Meters = null, stayInClassA = false, onProgress = () => {} }) {
  const center = nearestCenter(candidateBase.lat, candidateBase.lon, centers);
  const centerFree = freeCenterCapacityKW({ center, portfolioLoadKW: 0, params });
  const PavailKW = availablePowerKW({ RqFreeKW: centerFree, stayInClassA });
  const configs = candidateConfigs({ PavailKW, params });
  const total = configs.length * YEARS.length * SEASONS.length * DAY_TYPES.length;
  let done = 0;
  const evaluated = [];
  for (const cfg of configs) {
    const gen = evaluateConfigSteps({ cfg, candidateBase, cells, params, getBaseline, centerFree, dist04Meters });
    let r = gen.next();
    while (!r.done) {
      done++;
      onProgress(done, total);
      await new Promise((resolve) => setTimeout(resolve, 0));
      r = gen.next();
    }
    evaluated.push(r.value);
  }
  return finishCandidate({ center, centerFree, PavailKW, evaluated, params });
}

function finishCandidate({ center, centerFree, PavailKW, evaluated, params }) {
  const alpha = params.M3_queue.alpha_accessibility.value;

  const eligible = evaluated.filter((e) => e.scenarios && e.minAcc >= alpha);

  let verdict;
  let omegaStar = null;
  if (eligible.length > 0) {
    omegaStar = eligible.reduce((best, e) => (e.scenarios.low.NPVrub > best.scenarios.low.NPVrub ? e : best));
    verdict = omegaStar.scenarios.low.NPVrub > 0 ? `Ставить ${omegaStar.cfg.omega}` : omegaStar.scenarios.high.NPVrub > 0 ? `Запросить у сети точную стоимость присоединения (${omegaStar.cfg.omega})` : `Не ставить — даже при дешёвом присоединении ${omegaStar.cfg.omega} не окупается`;
  } else {
    const withEconomics = evaluated.filter((e) => e.scenarios);
    if (withEconomics.length === 0) {
      verdict = 'Нет доступных конфигураций — центр питания закрыт (класс В) или неизвестна стоимость балансировки';
    } else {
      omegaStar = withEconomics.reduce((best, e) => (e.minAcc > best.minAcc ? e : best));
      verdict = `Спрос выше возможностей каталога/сети — лучший вариант по доступности ${omegaStar.cfg.omega} (Acc=${(omegaStar.minAcc * 100).toFixed(0)}% < ${(alpha * 100).toFixed(0)}%)`;
    }
  }

  const dc60_1 = evaluated.find((e) => e.cfg.omega === 'DC60-1');
  const dc150_2s = evaluated.find((e) => e.cfg.omega === 'DC150-2S');

  return { center, centerFree, PavailKW, evaluated, eligible, omegaStar, verdict, recommended: recommendConfig(evaluated), comparison: { asAccepted: dc60_1, underSubsidy: dc150_2s } };
}
