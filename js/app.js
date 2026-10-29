// Точка входа статического сайта. Четыре раздела (хэш-роутинг):
//  #map      - карта зон: где стандартная станция РСЗС (150 кВт, 2 поста)
//              окупается, кандидаты модели, слои, поиск;
//  #passport - паспорт площадки до заявки на техприсоединение;
//  #compare  - модель против традиционного выбора + свои точки с баллами;
//  #method   - как это работает, словарь, данные, тесты.
// Зоны и площадки пула посчитаны офлайн (data/zones.json, npm run
// compute:zones), паспорт и сеть по часам - живым расчётом в браузере.
import { SEGMENTS, demandField, stationsActiveIn, plannedStationsPerYear } from './demand.js';
import { buildNetworkContext, equilibrium, localEquilibrium, dailySessions } from './equilibrium.js';
import { evaluateCandidateAsync, yearAverage, newClientsPerMln } from './equipment.js';
import { interpolateAnchors } from './economics.js';
import { thresholds, siteStatus, siteEconomics, robustness, loadFromSessions, utilization, taxiShare, siteMetrics, verdictRszs, paybackDemand, STATUS } from './econ-view.js';
import { mfppipCompensation, classAConnRange } from './grid.js';
import {
  initMap,
  renderDemandLayer,
  renderStationsLayer,
  renderCentersLayer,
  renderNeighbors,
  coordToLatLng,
  clusterExtentAtPixel,
  renderPortfolio,
  portfolioPickAtPixel,
  renderMkad,
  renderSlowStations,
  focusStation,
  renderZones,
  zoneAtPixel,
  renderPoint,
  showPopup,
  renderBenchmarks,
  benchmarkAtPixel,
} from './mapview.js';
import { renderPassport, updatePassportHour } from './passport.js';
import { runAllTests } from './tests.js';
import { scoreCandidateRaw, normalizeAndScore } from './scoring.js';
import { dist04FromKnownTp } from './grid.js';
import { ownerOf } from './stakeholders.js';
import { haversineKm } from './choice.js';

const EQUIPMENT = 'DC150-2';
const YEARS_ALL = [2026, 2027, 2028, 2029, 2030];
const SEASON_W = { winter: 5 / 12, summer: 7 / 12 };
const DAY_W = { weekday: 5 / 7, weekend: 2 / 7 };
// Сценарии как в презентации: базовый 30% в год (рост энергии сети РСЗС),
// быстрый 80% (рост парка Москвы; HADI-1 показал, что это не рост сессий).
const SCENARIO_LABEL = { base: 'базовый рост спроса 30% в год', fast: 'быстрый рост спроса 80% в год' };
const SCENARIO_GEN = { base: 'базового (30% в год)', fast: 'быстрого (80% в год)' };
const SCENARIO_NAME = SCENARIO_LABEL;

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const num = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d).replace('.', ','));
const fmtInt = (v) => Math.round(v).toLocaleString('ru-RU');
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const state = {
  ctl: { scenario: 'base', year: 2028, dayType: 'weekday', season: 'summer', hour: 12, funding: 'paid' },
  cells: null,
  stationsAll: null,
  centers: null,
  params: null,
  preciseParams: null, // с точным порогом сходимости (12.3) - для всего, что считает ΔS
  stations: null, // действующие в году и сценарии карты
  fullContext: null,
  fullResult: null,
  baselineS: null,
  baselineCache: new Map(), // "сценарий|год|сезон|день" -> {context, result, stations}
  zones: null, // data/zones.json
  siteById: new Map(), // площадки пула + расчёт зон
  portfolio: null,
  candidates: [], // кандидаты модели (портфель) для списка слева
  statusFilter: 'all',
  selected: null, // {type: 'site'|'zone'|'point', ...}
  checkMode: false,
  th: null, // пороги окупаемости класса А (econ-view thresholds)
  thSub: null, // то же с субсидией
  mkadRing: null,
  tp04: null,
  passport: null, // {subject, token, vm, e150, evalResult, ...}
  compareList: [],
  compareNextId: 1,
  compareSort: { key: 'composite', dir: 'desc' },
  geoCache: new Map(),
};

// ---------- Данные ----------
async function fetchJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

async function loadData() {
  // ТП 0.4 кВ и МКАД нужны до первого паспорта: без tp04 класс подключения
  // считался бы как Б (паспорт по прямой ссылке открывается сразу).
  const [cellsRaw, stationsRaw, centersRaw, params, zones, poolRaw, tp04Raw, mkadRaw] = await Promise.all([
    fetchJson('data/cells.json'),
    fetchJson('data/stations.json'),
    fetchJson('data/centers.json'),
    fetchJson('data/params.json'),
    fetchJson('data/zones.json'),
    fetchJson('data/pool.json'),
    fetchJson('data/tp04.json'),
    fetchJson('data/mkad.json'),
  ]);
  const benchmarks = await fetchJson('data/benchmarks.json').then((d) => d.benchmarks).catch(() => []);
  const ampp = await fetchJson('data/ampp.json').then((d) => d.points).catch(() => []);
  const taxiStands = await fetchJson('data/taxi-stands.json').then((d) => d.points).catch(() => []);
  return { ampp, taxiStands, cells: cellsRaw.cells, stationsAll: stationsRaw.stations, centers: centersRaw.centers, params, zones, pool: poolRaw.pool, tp04: tp04Raw.points, tp04Meta: tp04Raw.meta || [], mkadRing: mkadRaw.ring, benchmarks };
}

const cfg150 = () => state.params.M6_M7_equipment_economics.catalog.configs.find((c) => c.omega === EQUIPMENT);

// Пороги для карты: класс А, середина платы за подключение по реальным ТУ,
// 10% сессий такси, норматив окупаемости РСЗС (10 лет с 29.10), замена
// оборудования через 5 лет. thAmpp - подключение по программе АМПП (платы нет).
function computeThresholds() {
  const cfg = cfg150();
  const connMid = classAConnRange(state.params).mid;
  state.th = thresholds({ params: state.params, cfg, connCostRub: connMid });
  state.thSub = thresholds({ params: state.params, cfg, connCostRub: connMid, subsidy: true });
  state.thAmpp = thresholds({ params: state.params, cfg, connCostRub: 0 });
}

// Прогноз зарядок в сутки в году y из расчёта зон (2027/2029 - интерполяция, 9.3).
function sessionsIn(by, year) {
  if (!by?.S) return null;
  return interpolateAnchors(by.S, year);
}

// Парковки АМПП (data.mos.ru): станция в AMPP_M метрах от платной парковки
// города может пойти по программе АМПП - подключение за счёт сети (РСЗС 29.10).
const AMPP_M = 100;
// Зона - шестиугольник радиусом 850 м: место в ней можно выбрать у любой
// парковки АМПП в 500 м от точки зоны.
const AMPP_ZONE_M = 500;
function buildAmppIndex(points) {
  const cell = 0.005;
  const grid = new Map();
  for (const p of points) {
    const k = `${Math.floor(p[0] / cell)}|${Math.floor(p[1] / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(p);
  }
  return { cell, grid };
}
function nearestAmpp(lat, lon) {
  const idx = state.amppIndex;
  if (!idx) return null;
  const i0 = Math.floor(lat / idx.cell);
  const j0 = Math.floor(lon / idx.cell);
  const kLon = Math.cos((lat * Math.PI) / 180);
  let best = null;
  for (let di = -1; di <= 1; di++)
    for (let dj = -1; dj <= 1; dj++)
      for (const p of idx.grid.get(`${i0 + di}|${j0 + dj}`) || []) {
        const m = Math.hypot((p[0] - lat) * 111320, (p[1] - lon) * 111320 * kLon);
        if (!best || m < best.m) best = { m: Math.round(m), places: p[2], num: p[3] };
      }
  return best;
}
// Ближайшая стоянка такси (data.mos.ru, набор 621): 356 точек - перебором.
function nearestTaxiStand(lat, lon) {
  const kLon = Math.cos((lat * Math.PI) / 180);
  let best = null;
  for (const p of state.taxiStands || []) {
    const m = Math.hypot((p[0] - lat) * 111320, (p[1] - lon) * 111320 * kLon);
    if (!best || m < best.m) best = { m: Math.round(m), places: p[2], address: p[3] };
  }
  return best;
}

// Порог для статуса: при режиме «по АМПП» у мест рядом с парковкой АМПП - без платы за подключение.
function thFor(by) {
  return state.ctl.funding === 'ampp' && by?.amppOk ? state.thAmpp : state.th;
}

function statusOf(by, year, th = thFor(by)) {
  if (!by) return 'no';
  return siteStatus({ S: sessionsIn(by, year), cls: by.cls, th });
}

const clsLabel = (cls) => (cls === 'А|Б' ? 'Б' : cls || '—');

// ---------- Сеть: равновесие на выбранные год, сценарий, день, сезон ----------
function getBaseline(year, season, dayType, scenario = 'base') {
  const key = `${scenario}|${year}|${season}|${dayType}`;
  if (state.baselineCache.has(key)) return state.baselineCache.get(key);
  const stations = stationsActiveIn(state.stationsAll, year, scenario, state.preciseParams);
  const context = buildNetworkContext({ cells: state.cells, stations, params: state.preciseParams });
  const result = equilibrium({ cells: state.cells, stations, params: state.preciseParams, year, scenario, dayType, season, context });
  const entry = { context, result, stations };
  state.baselineCache.set(key, entry);
  return entry;
}

function setStatus(msg, kind = 'ok') {
  const el = document.getElementById('recompute-status');
  el.textContent = msg;
  el.dataset.kind = kind;
}

async function recomputeFullEquilibrium() {
  setStatus('Пересчитываю сеть…', 'busy');
  await nextFrame();
  const { dayType, season, year, scenario } = state.ctl;
  const t0 = performance.now();
  const base = getBaseline(year, season, dayType, scenario);
  state.stations = base.stations;
  state.fullContext = base.context;
  state.fullResult = base.result;
  state.baselineS = dailySessions(state.fullResult.qh.lambdaSrv, state.stations.length);
  console.log(`равновесие сети: ${Math.round(performance.now() - t0)} мс, ${state.fullResult.it} итераций`);
  setStatus(state.fullResult.converged ? '' : 'Расчёт сети не сошёлся — результат приблизительный', state.fullResult.converged ? 'ok' : 'warn');
  rerenderMapForHour();
  showChangeToast();
  if (state.compareList.length) {
    state.compareList = state.compareList.map((c) => ({ ...c, ...scoreFor(c) }));
    renderCompareList();
  }
}

// ---------- Слой «Спрос по часам» и станции по загрузке ----------
function totalDemandPerCellAtHour(demand, nCells, hour) {
  const arr = new Float64Array(nCells);
  for (const s of SEGMENTS) {
    const d = demand[s];
    for (let i = 0; i < nCells; i++) arr[i] += d[i * 24 + hour];
  }
  return arr;
}

function peakDemandHour(demand, nCells) {
  let best = 0;
  let bestSum = -1;
  for (let h = 0; h < 24; h++) {
    let sum = 0;
    for (const s of SEGMENTS) for (let i = 0; i < nCells; i++) sum += demand[s][i * 24 + h];
    if (sum > bestSum) {
      bestSum = sum;
      best = h;
    }
  }
  return best;
}

function cityPeakDemand(demand, nCells) {
  const h = peakDemandHour(demand, nCells);
  let sum = 0;
  for (const s of SEGMENTS) for (let i = 0; i < nCells; i++) sum += demand[s][i * 24 + h];
  return sum;
}

// Границы шкалы насыщенности: самая слабая комбинация и самая сильная в сценарии.
function demandBounds(scenario) {
  state.demandBoundsCache ??= new Map();
  if (!state.demandBoundsCache.has(scenario)) {
    const peak = (o) => cityPeakDemand(demandField({ cells: state.cells, params: state.preciseParams, scenario, ...o }), state.cells.length);
    state.demandBoundsCache.set(scenario, {
      lo: peak({ year: 2026, season: 'summer', dayType: 'weekend' }),
      hi: peak({ year: 2030, season: 'winter', dayType: 'weekday' }),
      base2026: peak({ year: 2026, season: 'winter', dayType: 'weekday' }),
    });
  }
  return state.demandBoundsCache.get(scenario);
}

function rerenderMapForHour() {
  const { hour, dayType, scenario } = state.ctl;
  document.getElementById('hour-label').textContent = `${String(hour).padStart(2, '0')}:00`;
  const { fullResult, cells, stations } = state;
  const Uarr = new Float64Array(stations.length);
  for (let j = 0; j < stations.length; j++) Uarr[j] = fullResult.qh.U[j * 24 + hour];
  renderStationsLayer({ stationsSource: state.layers.stationsSource, stations, activeStations: fullResult.activeStations, Uarr, onClickStation: null });
  if (document.getElementById('layer-demand').checked) {
    const bounds = demandBounds(scenario);
    const cityPeak = cityPeakDemand(fullResult.demand, cells.length);
    renderDemandLayer({
      demandSource: state.layers.demandSource,
      cells,
      totalDemandPerCell: totalDemandPerCellAtHour(fullResult.demand, cells.length, hour),
      scaleDemandPerCell: totalDemandPerCellAtHour(fullResult.demand, cells.length, peakDemandHour(fullResult.demand, cells.length)),
      intensity: Math.log(cityPeak / bounds.lo) / Math.log(bounds.hi / bounds.lo),
    });
    document.getElementById('map-legend-time').textContent = `${String(hour).padStart(2, '0')}:00 · ${dayType === 'weekend' ? 'выходной' : 'будни'}`;
    const k = cityPeak / bounds.base2026;
    document.getElementById('map-legend-volume').textContent = `в пик по городу ${fmtInt(cityPeak)} заявок/ч` + (Math.abs(k - 1) > 0.05 ? ` · ×${k < 10 ? num(k, 1) : Math.round(k)} к зиме 2026` : '');
  }
  if (state.passport?.vm) {
    state.passport.vm.hour = hour;
    updatePassportHour(state.passport.vm);
  }
}

// ---------- Карточка «Что изменилось» ----------
function networkSnapshot() {
  const { fullResult, cells, stations } = state;
  let demand = 0;
  for (const s of SEGMENTS) {
    const d = fullResult.demand[s];
    for (let i = 0; i < cells.length * 24; i++) demand += d[i];
  }
  let served = 0;
  let uSum = 0;
  let uN = 0;
  let active = 0;
  for (let j = 0; j < stations.length; j++) {
    if (!fullResult.activeStations[j]) continue;
    active++;
    for (let h = 0; h < 24; h++) {
      served += fullResult.qh.lambdaSrv[j * 24 + h];
      uSum += fullResult.qh.U[j * 24 + h];
      uN++;
    }
  }
  return { controls: { ...state.ctl }, demand, served, active, meanU: uN ? uSum / uN : 0, lostShare: demand > 0 ? Math.max(0, 1 - served / demand) : 0 };
}

function describeControlChange(a, b) {
  const parts = [];
  if (a.dayType !== b.dayType) parts.push(b.dayType === 'weekend' ? 'Выходные вместо будней' : 'Будни вместо выходных');
  if (a.season !== b.season) parts.push(b.season === 'winter' ? 'Зима вместо лета' : 'Лето вместо зимы');
  if (a.year !== b.year) parts.push(`${b.year} год вместо ${a.year}`);
  if (a.scenario !== b.scenario) parts.push(`${SCENARIO_NAME[b.scenario][0].toUpperCase()}${SCENARIO_NAME[b.scenario].slice(1)} вместо ${SCENARIO_GEN[a.scenario]}`);
  return parts;
}

let changeToastTimer = null;
function showChangeToast() {
  const cur = networkSnapshot();
  const prev = state.lastSnapshot;
  state.lastSnapshot = cur;
  const el = document.getElementById('change-toast');
  if (!prev) return;
  const parts = describeControlChange(prev.controls, cur.controls);
  if (parts.length === 0) return;
  const pctf = (v) => `${num(v * 100, 1)}%`;
  const rel = (a, b) => {
    if (a <= 0) return '';
    const r = (b / a - 1) * 100;
    if (Math.abs(r) < 0.5) return '<span class="ct-same">без изменений</span>';
    return `<span class="${r > 0 ? 'ct-up' : 'ct-down'}">${r > 0 ? '+' : '−'}${Math.abs(r) >= 100 ? `в ${num(b / a, 1)} раза` : `${Math.abs(r).toFixed(0)}%`}</span>`;
  };
  const pp = (a, b) => {
    const d = (b - a) * 100;
    if (Math.abs(d) < 0.05) return '<span class="ct-same">без изменений</span>';
    return `<span class="${d > 0 ? 'ct-up' : 'ct-down'}">${d > 0 ? '+' : '−'}${num(Math.abs(d), 1)} пункта</span>`;
  };
  const row = (label, a, b, delta) => `<tr><td>${label}</td><td class="num">${a}</td><td class="ct-arrow">→</td><td class="num"><b>${b}</b></td><td>${delta}</td></tr>`;
  const newStations = cur.active - prev.active;
  el.innerHTML = `
    <button class="ct-close" aria-label="Закрыть">✕</button>
    <div class="ct-kicker">Что изменилось в сети</div>
    <div class="ct-title">${parts.join(' · ')}</div>
    <table>
      ${row('Хотят зарядиться за сутки', fmtInt(prev.demand), fmtInt(cur.demand), rel(prev.demand, cur.demand))}
      ${row('Работает быстрых станций', fmtInt(prev.active), fmtInt(cur.active), newStations ? `<span class="${newStations > 0 ? 'ct-up' : 'ct-down'}">${newStations > 0 ? '+' : '−'}${Math.abs(newStations)} городских</span>` : '<span class="ct-same">без изменений</span>')}
      ${row('Зарядок за сутки по всей сети', fmtInt(prev.served), fmtInt(cur.served), rel(prev.served, cur.served))}
      ${row('Пост занят в среднем', pctf(prev.meanU), pctf(cur.meanU), pp(prev.meanU, cur.meanU))}
      ${row('Не смогли зарядиться', pctf(prev.lostShare), pctf(cur.lostShare), pp(prev.lostShare, cur.lostShare))}
    </table>`;
  el.hidden = false;
  el.classList.remove('ct-hide');
  el.querySelector('.ct-close').addEventListener('click', () => (el.hidden = true));
  clearTimeout(changeToastTimer);
  changeToastTimer = setTimeout(() => el.classList.add('ct-hide'), 9000);
  el.onmouseenter = () => {
    clearTimeout(changeToastTimer);
    el.classList.remove('ct-hide');
  };
  el.onmouseleave = () => {
    changeToastTimer = setTimeout(() => el.classList.add('ct-hide'), 5000);
  };
}

// ---------- Карта зон ----------
function zoneHint(z, by) {
  const S = sessionsIn(by, state.ctl.year);
  return `Зона · ${z.district}\n${num(S, 0)} зарядок в сутки в ${state.ctl.year}\n${STATUS[statusOf(by, state.ctl.year)].label}`;
}

function renderZonesView() {
  const { scenario, year } = state.ctl;
  const zones = state.zones.zones
    .filter((z) => z.by?.[scenario])
    .map((z) => {
      const by = z.by[scenario];
      const status = statusOf(by, year);
      const S = sessionsIn(by, year) ?? 0;
      const t = thFor(by);
      return { key: z.key, status, level: Math.max(0, Math.min(1, (S - t.pb) / Math.max(1e-6, t.npv - t.pb))), hint: zoneHint(z, by), zone: z };
    });
  renderZones({ zonesSource: state.layers.zonesSource, zones });
  renderZoneLegend(zones);
  renderKpis(zones);
  redrawPortfolioPins();
  renderCandidateList();
  if (state.selected) refreshPopup();
}

function countBy(list, key) {
  const c = { priority: 0, now: 0, grid: 0, no: 0 };
  for (const x of list) c[key(x)]++;
  return c;
}

function renderZoneLegend(zones) {
  const c = countBy(zones, (z) => z.status);
  const th = state.th;
  document.getElementById('zone-legend').innerHTML = `
    <div class="zl-title">Зоны на ${state.ctl.year}</div>
    <div class="zl-row"><i class="sw sw-now"></i><div><b>Строить</b> <span class="zl-n">${c.priority + c.now}</span><small>станция окупится за ${th.normYears} лет: прогноз от ${num(th.pb, 0)} зарядок в сутки и подстанция рядом. Тёмно-синие — с запасом, от ${num(th.npv, 0)} зарядок${state.ctl.funding === 'ampp' ? `. У парковок АМПП подключение за счёт сети — там хватает ${num(state.thAmpp.pb, 0)} зарядок` : ''}</small></div></div>
    <div class="zl-row"><i class="sw sw-grid"></i><div><b>Готовить сеть</b> <span class="zl-n">${c.grid}</span><small>спрос есть, но подстанции рядом нет — сначала запрос в «Россети»</small></div></div>
    <div class="zl-row"><i class="sw sw-no"></i><div><b>Не ставить</b> <span class="zl-n">${c.no}</span><small>за ${th.normYears} лет не окупится</small></div></div>`;
}

function renderKpis(zones) {
  const { scenario, year } = state.ctl;
  const c = countBy(zones, (z) => z.status);
  const ok = c.priority + c.now;
  const active = state.stationsAll.filter((st) => st.status !== 'planned' && !st.outside_mkad).length;
  let planned = 0;
  for (let y = 2027; y <= 2030; y++) planned += plannedStationsPerYear(y, scenario, state.params);
  let conclusion;
  const N = state.th.normYears;
  if (ok === 0) conclusion = c.grid > 0 ? `В ${year} году станция нигде не окупается за ${N} лет. Спрос есть только в ${c.grid} ${plural(c.grid, 'зоне', 'зонах', 'зонах')}, где нет подстанции рядом, — там начинать с запроса в «Россети».` : `В ${year} году станция нигде не окупается за ${N} лет. Посмотрите следующий год или включите компенсацию МФППиП в паспорте.`;
  else if (c.priority === 0) conclusion = `В ${year} году станция окупается за ${N} лет в ${ok} ${plural(ok, 'зоне', 'зонах', 'зонах')}, но без запаса. Строить точечно, в самых тёмных зонах.`;
  else conclusion = `В ${c.priority} ${plural(c.priority, 'зоне', 'зонах', 'зонах')} станция окупается с запасом — это первая волна. Ещё в ${c.now} окупается без запаса, в ${c.grid} сначала нужна сеть.`;
  document.getElementById('kpi-row').innerHTML = `
    <div class="kpi"><div class="kpi-label">Зон, где станция окупится, ${year}</div><div class="kpi-value">${ok}</div><div class="kpi-sub">из ${zones.length} зон внутри МКАД · за ${N} лет, как требует норматив РСЗС</div></div>
    <div class="kpi"><div class="kpi-label">Из них — с запасом</div><div class="kpi-value">${c.priority}</div><div class="kpi-sub">окупятся и с учётом стоимости денег (ставка 18%)</div></div>
    <div class="kpi"><div class="kpi-label">Быстрых станций к 2030</div><div class="kpi-value">~${fmtInt(active + planned)}</div><div class="kpi-sub">${active} уже работают, ещё ${planned} поставит город («Энергия Москвы»)</div></div>
    <div class="kpi kpi-dark"><div class="kpi-label">Коротко · ${esc(SCENARIO_LABEL[scenario])}</div><div class="kpi-text">${conclusion}</div></div>`;
}

// ---------- Кандидаты модели (список слева, пины) ----------
function buildCandidates() {
  const picks = state.portfolio?.model?.picks || [];
  state.candidates = picks.map((p, k) => ({ ...p, rank: k + 1, site: state.siteById.get(p.id) }));
}

function siteBy(site) {
  return site?.calc?.by?.[state.ctl.scenario] || null;
}

function siteName(site) {
  return site?.area || site?.district || 'Площадка';
}

function siteKindLine(site) {
  return `${site.kind}${site.name ? ` «${site.name}»` : ''}`;
}

function candidateView(c) {
  const by = siteBy(c.site);
  const S = sessionsIn(by, state.ctl.year);
  const status = by ? statusOf(by, state.ctl.year) : 'no';
  return { ...c, S, status, cls: by?.cls ?? c.cls };
}

function redrawPortfolioPins() {
  renderPortfolio({
    portfolioSource: state.layers.portfolioSource,
    portfolio: state.portfolio,
    showModel: document.getElementById('toggle-model').checked,
    showTraditional: document.getElementById('toggle-trad').checked,
    statusFor: (p) => statusOf(siteBy(state.siteById.get(p.id)), state.ctl.year),
  });
}

function renderCandidateList() {
  const all = state.candidates.map(candidateView).sort((a, b) => (b.S ?? -1) - (a.S ?? -1));
  const c = countBy(all, (x) => x.status);
  const chips = [
    ['all', 'Все', all.length],
    ['priority', 'Первая очередь', c.priority],
    ['now', 'Вторая очередь', c.now],
    ['grid', 'Готовить сеть', c.grid],
    ['no', 'Не ставить', c.no],
  ];
  const filterEl = document.getElementById('status-filter');
  filterEl.innerHTML = chips.map(([k, l, n]) => `<button class="chip ${state.statusFilter === k ? 'active' : ''}" data-filter="${k}">${l} <span>${n}</span></button>`).join('');
  filterEl.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      state.statusFilter = b.dataset.filter;
      renderCandidateList();
    })
  );
  const list = all.filter((x) => state.statusFilter === 'all' || x.status === state.statusFilter);
  document.getElementById('cand-count').textContent = list.length;
  const th = state.th;
  const scaleMax = Math.max(th.npv * 1.6, ...all.map((x) => x.S ?? 0));
  const pos = (v) => `${Math.min(100, (v / scaleMax) * 100).toFixed(1)}%`;
  const el = document.getElementById('cand-list');
  el.innerHTML = list
    .map((x) => {
      const st = STATUS[x.status];
      const sel = state.selected?.type === 'site' && state.selected.id === x.id ? ' selected' : '';
      return `<li class="cand${sel}" data-id="${esc(x.id)}" tabindex="0">
        <span class="cand-rank">${x.rank}</span>
        <div class="cand-body">
          <div class="cand-name">${esc(siteName(x.site))}<span class="tag tag-${st.tone}">${st.label}</span></div>
          <div class="cand-meta">${esc(siteKindLine(x.site || x))} · ${esc(x.id)} · подключение ${esc(clsLabel(x.cls))}</div>
          <div class="cand-bar tone-${st.tone}"><i style="width:${pos(x.S ?? 0)}"></i><b class="mk mk-pb" style="left:${pos(th.pb)}"></b><b class="mk mk-npv" style="left:${pos(th.npv)}"></b></div>
        </div>
        <div class="cand-num"><b>${num(x.S, 0)}</b><small>зарядок в сутки</small></div>
      </li>`;
    })
    .join('') || '<li class="cand-empty">В этом сценарии таких мест нет.</li>';
  el.querySelectorAll('li.cand').forEach((li) => {
    const open = () => selectSite(li.dataset.id, { pan: true });
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => e.key === 'Enter' && open());
  });
  document.getElementById('threshold-note').innerHTML = `Полоса — прогноз зарядок в сутки. Серая отметка (${num(th.pb, 0)}) — с этого станция окупается за ${th.normYears} лет. Чёрная (${num(th.npv, 0)}) — окупается с запасом, с учётом стоимости денег.`;
}

// ---------- Карточка на карте (кандидат, зона, точка) ----------
function popupHtml({ kicker, title, S, U, status, cfgLine, text, actions = true, note = '' }) {
  const st = STATUS[status];
  return `<button class="popup-close" data-action="close" aria-label="Закрыть">×</button>
    <div class="popup-kicker">${esc(kicker)}</div>
    <div class="popup-title">${esc(title)}</div>
    ${S !== null && S !== undefined ? `<div class="popup-big"><b>${num(S, 0)}</b><span>зарядок в сутки<br>в ${state.ctl.year} году</span></div>` : ''}
    ${st ? `<span class="tag tag-${st.tone} popup-status">${st.label} · ${esc(cfgLine)}</span>` : ''}
    <p class="popup-text">${text}</p>
    ${note ? `<p class="popup-note">${note}</p>` : ''}
    ${actions ? '<div class="popup-actions"><button class="btn-primary" data-action="passport">Открыть паспорт →</button><button class="btn-secondary" data-action="compare">Сравнить</button></div>' : ''}`;
}

function statusExplanation(status, S, by, year) {
  const th = state.th;
  // Первый год не раньше выбранного, когда прогноз доходит до порога; спрос
  // по годам не монотонен - городские станции 2027-2030 забирают клиентов.
  const crossYear = (lvl) => YEARS_ALL.find((y) => y > year && (sessionsIn(by, y) ?? 0) >= lvl);
  const earlier = (lvl) => YEARS_ALL.find((y) => y < year && (sessionsIn(by, y) ?? 0) >= lvl);
  const gapTxt = S >= th.pb ? '' : ` Чтобы окупиться за ${th.normYears} лет, нужно ${num(th.pb, 0)} зарядок в сутки — на ${num(th.pb - S, 0)} больше прогноза.`;
  if (by?.cls === 'В') return 'Свободной мощности у питающего центра нет (по нашей оценке) — без стройки сети станцию не подключить.';
  if (status === 'priority') return `Станция окупится с запасом: прогноз выше ${num(th.npv, 0)} зарядок в сутки, а подстанция рядом — подключение дешёвое и быстрое.`;
  if (status === 'now') {
    const y = crossYear(th.npv);
    return `Станция окупится за ${th.normYears} лет, но без запаса: для запаса нужно ${num(th.npv, 0)} зарядок в сутки${y ? ` — такой спрос будет к ${y}` : ''}. Вторая очередь.`;
  }
  if (status === 'grid') return `Спроса хватает (${num(S, 0)} зарядок при нужных ${num(th.pb, 0)}), но подстанции рядом нет — подключение может оказаться в разы дороже. Сначала запрос в «Россети».`;
  const y = crossYear(th.pb);
  const e = earlier(th.pb);
  return `Пока не окупится.${gapTxt}${e ? ` В ${e} спроса хватало: к ${year} часть клиентов заберут новые городские станции.` : ''} ${y ? `Нужный спрос появится к ${y}.` : 'До 2030 его не будет.'}`;
}

function wirePopup() {
  const el = state.layers.popupEl;
  el.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'close') return clearSelection();
    const sel = state.selected;
    if (!sel) return;
    if (action === 'passport') location.hash = passportHash(sel);
    if (action === 'compare') {
      addToCompare(sel.lat, sel.lon, sel.label);
      e.target.textContent = 'В сравнении ✓';
      e.target.disabled = true;
    }
  });
}

function passportHash(sel) {
  if (sel.type === 'site') return `#passport/site/${sel.id}`;
  if (sel.type === 'zone') return `#passport/zone/${sel.key}`;
  return `#passport/pt/${sel.lat.toFixed(5)},${sel.lon.toFixed(5)}`;
}

function clearSelection() {
  state.selected = null;
  showPopup(state.layers, null);
  renderPoint(state.layers, null);
  renderCandidateList();
}

function selectSite(id, { pan = false } = {}) {
  const site = state.siteById.get(id);
  if (!site) return;
  document.getElementById('map-hint').classList.add('gone');
  state.selected = { type: 'site', id, lat: site.lat, lon: site.lon, label: `${id} · ${siteName(site)}` };
  renderPoint(state.layers, null);
  refreshPopup();
  if (pan) state.layers.map.getView().animate({ center: ol.proj.fromLonLat([site.lon, site.lat]), zoom: Math.max(13, state.layers.map.getView().getZoom()), duration: 400 });
  renderCandidateList();
}

function selectZone(zone) {
  state.selected = { type: 'zone', key: zone.key, lat: zone.lat, lon: zone.lon, label: `Зона ${zone.district}` };
  renderPoint(state.layers, { lat: zone.lat, lon: zone.lon });
  refreshPopup();
  renderCandidateList();
}

function selectPoint(lat, lon) {
  state.selected = { type: 'point', lat, lon, label: 'Точка на карте' };
  renderPoint(state.layers, { lat, lon });
  refreshPopup();
  renderCandidateList();
}

function refreshPopup() {
  const sel = state.selected;
  if (!sel) return;
  if (sel.type === 'bench') {
    const b = state.benchStats?.find((x) => x.id === sel.id);
    if (b) state.layers.popupEl.innerHTML = benchPopupHtml(b);
    return;
  }
  const el = state.layers.popupEl;
  const year = state.ctl.year;
  if (sel.type === 'site') {
    const site = state.siteById.get(sel.id);
    const by = siteBy(site);
    const S = sessionsIn(by, year);
    const status = statusOf(by, year);
    const rank = state.candidates.find((c) => c.id === sel.id)?.rank;
    el.innerHTML = popupHtml({
      kicker: `Площадка ${sel.id}${rank ? ` · кандидат №${rank}` : ''}`,
      title: siteName(site),
      S,
      U: S !== null ? loadFromSessions(S, state.th, 2) : 0,
      status,
      cfgLine: `150 кВт, 2 поста, подключение ${clsLabel(by?.cls)}`,
      text: by ? statusExplanation(status, S, by, year) : 'Для этой площадки нет готового расчёта — откройте паспорт.',
      note: `${esc(siteKindLine(site))}${site.address ? `, ${esc(site.address)}` : ''}`,
    });
  } else if (sel.type === 'zone') {
    const z = state.zones.zones.find((x) => x.key === sel.key);
    const by = z.by[state.ctl.scenario];
    const S = sessionsIn(by, year);
    const status = statusOf(by, year);
    el.innerHTML = popupHtml({
      kicker: `Зона · ${z.district}`,
      title: z.atTp ? 'Станция у подстанции' : 'Станция в центре зоны',
      S,
      U: loadFromSessions(S, state.th, 2),
      status,
      cfgLine: `150 кВт, 2 поста, подключение ${clsLabel(by.cls)}`,
      text: statusExplanation(status, S, by, year),
      note: z.atTp ? 'Станцию ставим у трансформаторной подстанции этой зоны — так подключение дешевле.' : 'Подстанций в зоне в открытых данных нет — станцию ставим в центре зоны.',
    });
  } else {
    const inside = insideMkad(sel.lat, sel.lon);
    el.innerHTML = popupHtml({
      kicker: 'Новая точка',
      title: inside ? 'Проверить это место' : 'За пределами МКАД',
      S: null,
      status: null,
      text: inside ? 'Паспорт посчитает для станции 150 кВт в этой точке: сколько машин приедет, откуда, сколько стоит подключение и когда окупится. Это займёт несколько секунд.' : 'Там не собраны данные о станциях, поэтому модель эту точку не считает. Выберите место внутри пунктирного кольца.',
      actions: inside,
    });
  }
  showPopup(state.layers, sel.lat, sel.lon);
}

function insideMkad(lat, lon) {
  const ring = state.mkadRing;
  if (!ring) return true;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ai, bi] = ring[i];
    const [aj, bj] = ring[j];
    if (ai > lat !== aj > lat && lon < ((bj - bi) * (lat - ai)) / (aj - ai) + bi) inside = !inside;
  }
  return inside;
}

function onMapClick(evt) {
  document.getElementById('map-hint').classList.add('gone');
  const map = state.layers.map;
  if (state.checkMode) {
    setCheckMode(false);
    const { lat, lng } = coordToLatLng(evt.coordinate);
    if (!insideMkad(lat, lng)) return selectPoint(lat, lng);
    location.hash = `#passport/pt/${lat.toFixed(5)},${lng.toFixed(5)}`;
    return;
  }
  const extent = clusterExtentAtPixel(map, state.layers.stationsLayer, evt.pixel);
  if (extent) {
    map.getView().fit(extent, { padding: [60, 60, 60, 60], maxZoom: 16, duration: 300 });
    return;
  }
  const bench = state.layers.benchLayer.getVisible() ? benchmarkAtPixel(map, state.layers.benchLayer, evt.pixel) : null;
  if (bench) return selectBenchmark(bench);
  const pick = portfolioPickAtPixel(map, evt.pixel);
  if (pick) return selectSite(pick.id);
  const zone = state.layers.zonesLayer.getVisible() ? zoneAtPixel(map, state.layers.zonesLayer, evt.pixel) : null;
  if (zone) return selectZone(zone);
  const { lat, lng } = coordToLatLng(evt.coordinate);
  selectPoint(lat, lng);
}

function setCheckMode(on) {
  state.checkMode = on;
  const btn = document.getElementById('check-point-btn');
  btn.classList.toggle('active', on);
  btn.textContent = on ? 'Нажмите точку на карте… (Esc — отмена)' : '+ Проверить новую точку';
  document.querySelector('.map-card').classList.toggle('picking', on);
  const hint = document.getElementById('map-hint');
  hint.textContent = on ? 'Нажмите в любое место внутри МКАД — откроется паспорт этой точки' : 'Нажмите на зону или кандидата, чтобы увидеть прогноз';
  hint.classList.toggle('gone', !on);
}

// ---------- Эталонные станции РСЗС (ТЗ от 20.10) ----------
// Модель на эталонах не настраивается, только сверяется: место эталона в
// сети РСЗС (станции с метками «РСЗС» и «Энергия Москвы») по сессиям в
// сутки и по загрузке поста. 2026 год, базовый сценарий, средний день года.
// Несколько станций модели по одному адресу (колонки одной площадки) - одна
// единица: сессии суммируются, загрузка - средняя по постам.
const RSZS_OPERATORS = new Set(['РСЗС', 'Энергия Москвы']);
const BENCH_YEAR = 2026;

async function benchmarkStats() {
  if (state.benchStats) return state.benchStats;
  if (!state.benchmarks?.length) return (state.benchStats = []);
  const combos = [];
  for (const season of ['winter', 'summer'])
    for (const dayType of ['weekday', 'weekend']) {
      await nextFrame();
      combos.push({ w: SEASON_W[season] * DAY_W[dayType], b: getBaseline(BENCH_YEAR, season, dayType, 'base') });
    }
  const stations = combos[0].b.stations;
  const n = stations.length;
  const S = new Float64Array(n);
  const U = new Float64Array(n);
  for (const { w, b } of combos) {
    const s = dailySessions(b.result.qh.lambdaSrv, n);
    for (let j = 0; j < n; j++) {
      S[j] += w * s[j];
      let u = 0;
      for (let h = 0; h < 24; h++) u += b.result.qh.U[j * 24 + h];
      U[j] += (w * u) / 24;
    }
  }
  // Эталон - точка: станции модели в radius_m от неё (номера S-xxxx при
  // пересборке данных меняются, по ним не ссылаемся).
  const groupOf = (b) => stations.map((st, j) => (haversineKm(b.lat, b.lon, st.lat, st.lon) * 1000 <= (b.radius_m ?? 40) ? j : -1)).filter((j) => j >= 0);
  const groups = new Map(state.benchmarks.map((b) => [b.id, groupOf(b)]));
  const inBench = new Set([...groups.values()].flat());
  const unit = (js) => {
    const posts = js.reduce((a, j) => a + stations[j].posts, 0);
    return { S: js.reduce((a, j) => a + S[j], 0), U: posts ? js.reduce((a, j) => a + U[j] * stations[j].posts, 0) / posts : 0, found: js.length };
  };
  const units = [];
  stations.forEach((st, j) => {
    if (RSZS_OPERATORS.has(st.operator) && !st.outside_mkad && !inBench.has(j)) units.push({ S: S[j], U: U[j] });
  });
  const items = state.benchmarks.map((b) => {
    const js = groups.get(b.id);
    const u = unit(js);
    return { ...b, ...u, station_ids: js.map((j) => stations[j].id), lat: js.length ? b.lat : null, lon: b.lon, posts: js.reduce((a, j) => a + stations[j].posts, 0), P_kW: js.reduce((a, j) => a + stations[j].P_kW, 0) };
  });
  const all = [...units, ...items];
  const N = all.length;
  const rank = (v, key) => 1 + all.filter((x) => x[key] > v).length;
  state.benchStats = items
    .filter((b) => b.lat !== null)
    .map((b) => {
      const rankS = rank(b.S, 'S');
      const rankU = rank(b.U, 'U');
      // «Расхождение»: лидер ниже середины сети по загрузке, слабая - выше.
      const mismatch = b.type === 'weak' ? rankU <= N / 2 : rankU > N / 2;
      return { ...b, N, rankS, rankU, mismatch };
    });
  return state.benchStats;
}

function benchPopupHtml(b) {
  const isWeak = b.type === 'weak';
  return `<button class="popup-close" data-action="close" aria-label="Закрыть">×</button>
    <div class="popup-kicker">Эталон РСЗС · ${isWeak ? 'слабая станция' : 'лидер'}</div>
    <div class="popup-title">${esc(b.address)}</div>
    <div class="bench-cols">
      <div><div class="bench-h">Известно от РСЗС</div><p>${esc(b.rszs)}</p><p class="popup-note">${esc(b.source)}${b.launched ? `. Запуск: ${esc(b.launched)}` : ''}</p></div>
      <div><div class="bench-h">Считает модель</div>
        <p><b>${num(b.S, 1)}</b> зарядки в сутки<br>пост занят <b>${num(b.U * 100, 1)}%</b> времени</p>
        <p class="popup-note">Среди ${b.N} станций РСЗС: ${b.rankS}-е место по числу зарядок, ${b.rankU}-е по загрузке. ${BENCH_YEAR}, базовый сценарий, средний день года. ${b.posts} пост(ов), ${b.P_kW} кВт, станции ${esc(b.station_ids.join(', '))}</p></div>
    </div>
    ${b.mismatch ? `<p class="bench-mismatch"><b>Расхождение с РСЗС:</b> по загрузке модель ставит эту станцию ${isWeak ? 'выше' : 'ниже'} середины сети. Уточнится, когда модель получит почасовые данные РСЗС в пилоте.</p>` : ''}
    ${b.note ? `<p class="popup-note">Данные: ${esc(b.note)}</p>` : ''}`;
}

async function selectBenchmark(b) {
  state.selected = { type: 'bench', id: b.id, lat: b.lat, lon: b.lon, label: b.address };
  renderPoint(state.layers, null);
  state.layers.popupEl.innerHTML = benchPopupHtml(b);
  showPopup(state.layers, b.lat, b.lon);
}

async function showBenchmarkLayer(on) {
  state.layers.benchLayer.setVisible(on);
  if (!on || state.benchRendered) return;
  setStatus('Считаю эталоны РСЗС…', 'busy');
  const items = await benchmarkStats();
  renderBenchmarks(state.layers, items);
  state.benchRendered = true;
  setStatus('');
}

// Ближайший эталон для паспорта (ТЗ, шаг 3.4).
function nearestBenchmark(lat, lon) {
  const items = state.benchStats;
  if (!items?.length) return null;
  let best = null;
  for (const b of items) {
    const d = haversineKm(lat, lon, b.lat, b.lon);
    if (!best || d < best.distKm) best = { ...b, distKm: d };
  }
  return best;
}

// ---------- Участники проекта (эксперт вуза, 28.10) ----------
// Все стороны, с которыми придётся договариваться по точке: сетевая
// компания (ближайшая ТП и питающий центр), правообладатель площадки,
// город, соседние операторы и партнёры по спросу.
function nearestTpInfo(lat, lon) {
  if (!state.tp04) return null;
  let best = -1;
  let bestD = Infinity;
  const kLon = Math.cos((lat * Math.PI) / 180);
  state.tp04.forEach(([la, lo], i) => {
    if (Math.abs(la - lat) > 0.01) return;
    const d = Math.hypot((la - lat) * 111320, (lo - lon) * 111320 * kLon);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  if (best < 0 || bestD > 1500) return null;
  const [ref, operator, address] = state.tp04Meta?.[best] || [];
  return { dist: Math.round(bestD), ref, operator, address };
}

// Сколько действующих станций и кандидатов модели опираются на тот же
// питающий центр - они делят его свободную мощность.
function centerLoad(centerId) {
  if (!centerId) return null;
  if (!state.centerOf) {
    const nearest = (lat, lon) => state.centers.reduce((b, c) => ((c.lat - lat) ** 2 + ((c.lon - lon) * 0.56) ** 2 < (b.lat - lat) ** 2 + ((b.lon - lon) * 0.56) ** 2 ? c : b)).id;
    state.centerOf = new Map();
    for (const st of state.stationsAll) if (st.status !== 'planned' && !st.outside_mkad) state.centerOf.set(st.id, nearest(st.lat, st.lon));
    state.centerOfPick = new Map((state.portfolio?.model?.picks || []).map((p) => [p.id, nearest(p.lat, p.lon)]));
  }
  let stations = 0;
  let kw = 0;
  for (const st of state.stationsAll) {
    if (state.centerOf.get(st.id) === centerId) {
      stations++;
      kw += st.P_kW;
    }
  }
  const picks = [...state.centerOfPick].filter(([, c]) => c === centerId).map(([id]) => id);
  return { stations, kw, picks };
}

function stakeholdersFor(P, center) {
  const s = P.subject;
  const tp = nearestTpInfo(s.lat, s.lon);
  const centerFull = center?.id ? state.centers.find((c) => c.id === center.id) : null;
  const owner = s.owner || (s.osm ? ownerOf(s.osm) : null);
  const losers = (P.live?.neighbors || []).filter((n) => n.deltaS < 0);
  const byOp = new Map();
  for (const n of losers) {
    const st = state.stations[n.globalJ];
    const op = st?.status === 'planned' ? 'городские станции (план)' : !st?.operator || st.operator === 'независимый' ? 'станции без сети' : st.operator;
    byOp.set(op, (byOp.get(op) || 0) - n.deltaS);
  }
  const competitors = [...byOp].sort((a, b) => b[1] - a[1]).map(([op, loss]) => ({ op, loss }));
  return {
    tp,
    center: centerFull ? { id: centerFull.id, name: centerFull.name, voltage: centerFull.voltage_kV, freeMW: center.freeMW, load: centerLoad(centerFull.id) } : null,
    owner,
    osm: s.osm || null,
    siteKind: s.siteKind || null,
    siteTitle: s.siteTitle || null,
    competitors,
  };
}

// ---------- Поиск: станции, площадки, районы ----------
let slowStationsPromise = null;
function loadSlowStations() {
  slowStationsPromise ??= fetchJson('data/stations-slow.json').then((d) => d.stations);
  return slowStationsPromise;
}

const normalizeForSearch = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/[.,«»"()/-]/g, ' ');

function wireSearch() {
  const input = document.getElementById('station-search-input');
  const list = document.getElementById('station-search-results');
  let index = null;
  let results = [];
  let active = -1;

  const buildIndex = async () => {
    const sites = [...state.siteById.values()].map((s) => ({ kind: 'site', s, hay: normalizeForSearch(`${s.id} ${s.id.replace('L-', '')} ${s.area || ''} ${s.address || ''} ${s.kind} ${s.name || ''} ${s.district}`) }));
    const fast = state.stationsAll.filter((st) => st.status !== 'planned').map((st) => ({ kind: 'station', st, slow: false }));
    const slow = (await loadSlowStations()).map((st) => ({ kind: 'station', st, slow: true }));
    index = [...sites, ...[...fast, ...slow].map((e) => ({ ...e, hay: normalizeForSearch(`${e.st.address || ''} ${e.st.operator} ${e.st.id}`) }))];
  };

  const stationLine = (e) => `${e.st.operator} · ${e.slow ? 'медленная' : 'быстрая'} станция, ${e.st.posts} пост(ов)${e.st.P_known ? ` по ${e.st.P_post_kW} кВт` : ''}`;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  const choose = (e) => {
    close();
    if (e.kind === 'site') {
      input.value = `${e.s.id} · ${siteName(e.s)}`;
      showView('map');
      return selectSite(e.s.id, { pan: true });
    }
    input.value = e.st.address || e.st.operator;
    if (e.slow) {
      const toggle = document.getElementById('toggle-slow');
      if (!toggle.checked) {
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
      }
    }
    document.getElementById('map-hint').classList.add('gone');
    focusStation(state.layers, e.st, `${e.st.address || 'адрес неизвестен'}\n${stationLine(e)}${e.slow ? '\nв модель не входит' : ''}`);
  };

  const render = () => {
    list.replaceChildren(
      ...(results.length
        ? results.map((e, i) => {
            const li = document.createElement('li');
            li.setAttribute('role', 'option');
            li.className = i === active ? 'active' : '';
            const t = document.createElement('b');
            const m = document.createElement('span');
            if (e.kind === 'site') {
              t.textContent = `${e.s.id} · ${siteName(e.s)}`;
              m.textContent = `площадка: ${siteKindLine(e.s)}${e.s.address ? `, ${e.s.address}` : ''}`;
            } else {
              t.textContent = e.st.address || 'адрес неизвестен';
              m.textContent = stationLine(e);
            }
            li.append(t, m);
            li.addEventListener('mousedown', (ev) => {
              ev.preventDefault();
              choose(e);
            });
            return li;
          })
        : [Object.assign(document.createElement('li'), { className: 'empty', textContent: 'Ничего не нашлось' })])
    );
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  input.addEventListener('focus', () => {
    if (!index) buildIndex();
  });
  input.addEventListener('input', async () => {
    const words = normalizeForSearch(input.value).split(/\s+/).filter(Boolean);
    if (!words.length) {
      results = [];
      close();
      focusStation(state.layers, null);
      return;
    }
    if (!index) await buildIndex();
    results = index.filter((e) => words.every((w) => e.hay.includes(w))).slice(0, 10);
    active = results.length ? 0 : -1;
    render();
  });
  input.addEventListener('keydown', (ev) => {
    if (list.hidden || !results.length) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      active = (active + (ev.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length;
      render();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      choose(results[Math.max(active, 0)]);
    } else if (ev.key === 'Escape') close();
  });
  input.addEventListener('blur', close);
}

// ---------- Паспорт ----------
async function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (state.geoCache.has(key)) return state.geoCache.get(key);
  let value = null;
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&extratags=1&accept-language=ru&lat=${lat}&lon=${lon}`);
    if (r.ok) {
      const j = await r.json();
      const a = j.address || {};
      const x = j.extratags || {};
      const street = a.road || a.pedestrian || a.footway || a.square || null;
      // Объект в точке - для «Участников проекта» (кто правообладатель).
      const o = { category: j.category, type: j.type, name: j.name || null, operator: x.operator || null, fee: x.fee || null, access: x.access || null, parking: x.parking || null, residential: a.residential || null, landuse: j.category === 'landuse' ? j.type : null };
      value = { address: street ? (a.house_number ? `${street}, ${a.house_number}` : street) : null, area: (a.suburb || a.city_district || '').replace(/^(район|поселение|муниципальный округ)\s+/i, '') || null, osm: o, owner: ownerOf(o) };
    }
  } catch {
    value = null;
  }
  state.geoCache.set(key, value);
  return value;
}

function nearestCell(lat, lon) {
  return state.cells.reduce((best, c) => ((c.lat - lat) ** 2 + ((c.lon - lon) * 0.56) ** 2 < (best.lat - lat) ** 2 + ((best.lon - lon) * 0.56) ** 2 ? c : best));
}

function subjectFromRoute(parts) {
  const [kind, arg] = parts;
  if (kind === 'site') {
    const s = state.siteById.get(arg);
    if (!s) return null;
    return { kind, id: arg, lat: s.lat, lon: s.lon, title: `Площадка ${arg}`, subtitle: siteName(s), address: s.address ? `${siteKindLine(s)}, ${s.address}` : siteKindLine(s), district: s.district, pre: s.calc, owner: s.owner || null, osm: s.osm_object || null, siteKind: s.kind, siteTitle: s.name || null };
  }
  if (kind === 'zone') {
    const z = state.zones.zones.find((x) => x.key === arg);
    if (!z) return null;
    return { kind, id: arg, lat: z.lat, lon: z.lon, title: `Зона ${z.district}`, subtitle: z.atTp ? 'у трансформаторной подстанции' : 'центр зоны', address: null, district: z.district, pre: z, geocode: true };
  }
  if (kind === 'pt') {
    const [lat, lon] = (arg || '').split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const cell = nearestCell(lat, lon);
    return { kind, id: arg, lat, lon, title: 'Точка на карте', subtitle: cell.district, address: null, district: cell.district, pre: null, geocode: true };
  }
  return null;
}

// Прогноз по годам и разброс по режимам из одной оценённой конфигурации.
function seriesFromEval(e) {
  const anchors = e.years;
  const combos = (year) => ['winter', 'summer'].flatMap((season) => ['weekday', 'weekend'].map((d) => Object.values(e.sessionsByCombo[`${year}|${season}|${d}`]).reduce((x, y) => x + y, 0)));
  const avg = Object.fromEntries(anchors.map((y) => [y, yearAverage(e, y).sessions]));
  const lo = Object.fromEntries(anchors.map((y) => [y, Math.min(...combos(y))]));
  const hi = Object.fromEntries(anchors.map((y) => [y, Math.max(...combos(y))]));
  const S = {};
  const Srange = {};
  for (const y of YEARS_ALL) {
    S[y] = interpolateAnchors(avg, y);
    Srange[y] = [interpolateAnchors(lo, y), interpolateAnchors(hi, y)];
  }
  const seg = {};
  for (const season of ['winter', 'summer'])
    for (const d of ['weekday', 'weekend'])
      for (const [s, v] of Object.entries(e.sessionsByCombo[`2026|${season}|${d}`])) seg[s] = (seg[s] || 0) + SEASON_W[season] * DAY_W[d] * v;
  return { S, Srange, seg };
}

function seriesFromPre(by) {
  const S = {};
  const Srange = {};
  for (const y of YEARS_ALL) {
    S[y] = sessionsIn(by, y);
    const lo = Object.fromEntries(Object.entries(by.Srange).map(([k, v]) => [k, v[0]]));
    const hi = Object.fromEntries(Object.entries(by.Srange).map(([k, v]) => [k, v[1]]));
    Srange[y] = [interpolateAnchors(lo, y), interpolateAnchors(hi, y)];
  }
  return { S, Srange, seg: by.seg2026 };
}

// Перцентиль значения среди массива (0..1).
function percentile(sorted, v) {
  if (!sorted.length) return 0;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

function whyBars(lat, lon, seg) {
  if (!state.whyDist) {
    const zs = state.zones.zones.map((z) => z.by?.base?.seg2026).filter(Boolean);
    const sorted = (f) => zs.map(f).sort((a, b) => a - b);
    state.whyDist = {
      P1: sorted((s) => s.P1 || 0),
      T: sorted((s) => s.T || 0),
      road: state.cells.map((c) => c.layers.road).sort((a, b) => a - b),
    };
  }
  // Конкуренты - действующие в выбранном году станции в 1 км; распределение по
  // зонам пересчитывается при смене сети (год, сценарий).
  const active = state.stations.filter((st, j) => state.fullResult.activeStations[j]);
  const near = (la, lo) => active.reduce((n, st) => n + (haversineKm(la, lo, st.lat, st.lon) <= 1 ? 1 : 0), 0);
  if (state.compDistFor !== state.fullResult) {
    state.compDist = state.zones.zones.map((z) => near(z.lat, z.lon)).sort((a, b) => a - b);
    state.compDistFor = state.fullResult;
  }
  const compCounts = state.compDist;
  const comp = near(lat, lon);
  const cell = nearestCell(lat, lon);
  return [
    { label: 'Жители без домашней зарядки', note: `${num(seg.P1 || 0, 1)} зарядок в сутки, 2026`, value: percentile(state.whyDist.P1, seg.P1 || 0), tone: 'pos' },
    { label: 'Такси и каршеринг', note: `${num(seg.T || 0, 1)} зарядок в сутки, 2026`, value: percentile(state.whyDist.T, seg.T || 0), tone: 'pos' },
    { label: 'Трафик на подъезде', note: 'плотность и класс дорог в квадрате 1 км', value: percentile(state.whyDist.road, cell.layers.road), tone: 'pos-light' },
    { label: 'Конкуренты в радиусе 1 км', note: `${comp} ${plural(comp, 'быстрая станция', 'быстрые станции', 'быстрых станций')} в ${state.ctl.year}`, value: percentile(compCounts, comp), tone: 'neg' },
  ];
}

function assumptionsChips() {
  const p = state.params;
  const m7 = p.M6_M7_equipment_economics;
  return [
    `${p.M3_queue.e_kWh.P0_P1_C.value} кВт·ч на зарядку`,
    `тариф ${m7.tariff_incl_vat_rub_per_kWh.retail_and_corporate.value} ₽`,
    `энергия ${m7.p_el_rub_per_kWh.value} ₽ за кВт·ч`,
    `эквайринг ${Math.round(m7.f_acq.value * 100)}%`,
    `ставка ${Math.round(m7.r_discount_rate.value * 100)}%`,
    `срок ${m7.H_years.value} лет`,
  ];
}

function buildPassportVm(P) {
  const { subject } = P;
  const scenario = state.ctl.scenario;
  const year = state.ctl.year;
  const subsidy = P.subsidy && !P.ampp;
  const ampp = !!P.ampp;
  const th = ampp ? state.thAmpp : subsidy ? state.thSub : state.th;
  const pre = subject.pre?.by?.[scenario] || null;
  let series = null;
  let cls = null;
  let dist04 = null;
  let conn = null;
  let center = null;
  if (P.e150) {
    series = seriesFromEval(P.e150);
    cls = P.e150.cls;
    dist04 = P.dist04;
    conn = P.e150.connRange ? { cost: [P.e150.connRange.costLow, P.e150.connRange.costHigh], months: [P.e150.connRange.monthsLow, P.e150.connRange.monthsHigh] } : null;
    center = P.evalResult ? { id: P.evalResult.center.id, freeMW: P.evalResult.centerFree / 1000 } : null;
  } else if (pre?.S) {
    series = seriesFromPre(pre);
    cls = pre.cls;
    dist04 = pre.dist04;
    conn = pre.conn;
    center = pre.center;
  }
  if (!series) return null;

  const U = {};
  const Urange = {};
  // Загрузка: в живом расчёте - сессии × длительность по группам водителей
  // (такси заряжается дольше), до него - средняя длительность из порогов.
  const uAnch = P.e150 ? Object.fromEntries(P.e150.years.map((y) => [y, utilization(P.e150, y, state.params)])) : null;
  for (const y of YEARS_ALL) {
    U[y] = uAnch ? interpolateAnchors(uAnch, y) : loadFromSessions(series.S[y], th, 2);
    const k = series.S[y] > 0 ? U[y] / series.S[y] : 0;
    Urange[y] = series.Srange[y].map((s) => s * k);
  }
  // Таблица по годам, как в паспорте точки №7 на слайде 22.
  const yearRows = P.e150
    ? P.e150.years.map((y) => ({ year: y, S: yearAverage(P.e150, y).sessions, U: utilization(P.e150, y, state.params), taxi: taxiShare(P.e150, y), free: 1 - utilization(P.e150, y, state.params, { season: 'winter', dayType: 'weekday' }), gain: yearAverage(P.e150, y).gain }))
    : null;

  let econ = null;
  let robust = null;
  let classBNpv = null;
  if (P.e150?.connRange) {
    const hi = siteEconomics(P.e150, { params: state.params, subsidy, ampp, connBound: 'high', launchYear: year });
    const lo = siteEconomics(P.e150, { params: state.params, subsidy, ampp, connBound: 'low', launchYear: year });
    econ = { ...hi, capexRange: [lo.capex, hi.capex], paybackRange: [lo.payback, hi.payback] };
    // Метрики ТЗ по экономике площадки (уровни 1 и 2).
    const net = siteEconomics(P.e150, { params: state.params, subsidy, ampp, connBound: 'high', launchYear: year });
    const netNpv = siteEconomics(P.e150, { params: state.params, subsidy, ampp, connBound: 'high', launchYear: year, network: true }).npv;
    const anchor = P.e150.years.includes(year) ? year : 2026;
    const comp = (c) => mfppipCompensation({ connCostRub: c, params: state.params });
    econ.tz = {
      ...siteMetrics(P.e150, anchor, { params: state.params, capex: hi.capex }),
      year: anchor,
      capexNoSub: [lo.capex, hi.capex],
      capexMfppip: ampp ? [lo.capex, hi.capex] : [lo.capex - comp(lo.connCost), hi.capex - comp(hi.connCost)],
      paybackDisc: net.paybackDisc,
      npvStation: net.npv,
      npvNetwork: netNpv,
      verdict: verdictRszs({ npvExpensive: hi.npv, npvCheap: lo.npv, paybackExpensive: hi.payback, normYears: th.normYears }),
    };
    robust = robustness(P.e150, { params: state.params, subsidy, ampp, launchYear: year });
    // Сколько зарядок в сутки нужно для окупаемости за норматив (идея команды 27.10).
    const pd = paybackDemand(P.e150, { params: state.params, subsidy, ampp, launchYear: year, normYears: th.normYears });
    const Snow = series.S[year];
    const need = (m) => (m === null ? null : { mult: m, sessions: m * Snow, year: YEARS_ALL.find((y) => y >= year && series.S[y] >= m * Snow) ?? null });
    econ.need = { expensive: need(pd.expensive), cheap: need(pd.cheap), forecast: Snow };
    if (cls === 'А' && !ampp) {
      const m5 = state.params.M5_grid;
      const P_kW = P.e150.cfg.P_cap_kW;
      classBNpv = siteEconomics(P.e150, { params: state.params, subsidy, connOverride: { cost: m5.c_B_rub_per_kW.max * P_kW, months: m5.T_conn_months.B.max }, launchYear: year }).npv;
    }
  } else if (pre?.npv && year === 2026) {
    // В zones.json экономика посчитана для решения в 2026 - для другого года ждём живой расчёт.
    econ = { npv: pre.npv[0], payback: pre.payback?.[1] ?? null, capexRange: pre.capex, subsidyRub: 0 };
  }

  const S = series.S[year];
  const status = siteStatus({ S, cls, th });
  const crossYear = (lvl) => YEARS_ALL.find((y) => y > year && series.S[y] >= lvl);
  const earlier = (lvl) => YEARS_ALL.find((y) => y < year && series.S[y] >= lvl);
  let recTitle;
  let recText;
  if (cls === 'В') {
    recTitle = 'Не ставить';
    recText = 'Свободной мощности у питающего центра нет (по нашей оценке) — без стройки сети станцию не подключить.';
  } else if (status === 'priority') {
    recTitle = 'Строить в первую очередь';
    recText = `На карте это место первой очереди: ${num(S, 1)} зарядки в сутки — больше, чем нужно для окупаемости с запасом (${num(th.npv, 0)}), и подстанция рядом.`;
  } else if (status === 'now') {
    const y = crossYear(th.npv);
    recTitle = 'Строить во вторую очередь';
    recText = `На карте это место второй очереди: ${num(S, 1)} зарядки в сутки — хватает, чтобы окупиться за ${th.normYears} лет (${num(th.pb, 0)}), но для запаса нужно ${num(th.npv, 0)}${y ? `, такой спрос будет к ${y}` : ', и до 2030 его не будет'}.`;
  } else if (status === 'grid') {
    recTitle = 'Готовить сеть';
    recText = `Спроса хватает (${num(S, 0)} зарядок при нужных ${num(th.pb, 0)}), но подстанции рядом нет. Если подключение окажется дорогим, нужно уже ${num(P.thB?.pb ?? NaN, 0)} зарядок. Сначала запрос в «Россети» или площадка ближе к подстанции.`;
  } else {
    const y = crossYear(th.pb);
    const e = earlier(th.pb);
    recTitle = 'Не ставить сейчас';
    recText = `На карте здесь пока не строить: ${num(S, 0)} зарядок в сутки при нужных ${num(th.pb, 0)}.${e ? ` В ${e} спроса хватало — к ${year} часть клиентов заберут городские станции.` : ''} ${y ? `Нужный спрос появится к ${y} — тогда вернуться к площадке.` : 'До 2030 нужного спроса не будет.'}`;
  }

  const m7 = state.params.M6_M7_equipment_economics;
  const cfg = cfg150();
  return {
    subject,
    scenario,
    scenarioLabel: SCENARIO_LABEL[scenario],
    year,
    hour: state.ctl.hour,
    subsidy,
    ampp,
    amppNear: nearestAmpp(subject.lat, subject.lon),
    taxiNear: nearestTaxiStand(subject.lat, subject.lon),
    amppMaxM: AMPP_M,
    econLive: !!P.e150,
    dateStr: new Date().toLocaleDateString('ru-RU'),
    th,
    S: series.S,
    Srange: series.Srange,
    U,
    Urange,
    cls,
    clsLabel: clsLabel(cls),
    clsText: cls === 'А' ? 'класс А — подстанция рядом' : cls === 'В' ? 'класс В — нет свободной мощности' : 'класс Б — подстанции рядом нет',
    dist04,
    conn,
    center,
    econ,
    robust,
    classBNpv,
    status,
    recTitle,
    recText,
    why: whyBars(subject.lat, subject.lon, series.seg),
    costs: {
      eq: cfg.C_eq_mln_rub * 1e6,
      rentMonth: m7.rent_rub_per_place_month.value * cfg.posts,
      serviceYear: m7.maintenance_share_Ceq_per_year.value * cfg.C_eq_mln_rub * 1e6 + m7.connectivity_insurance_rub_per_year.value,
      otherYear: m7.opex_other_rub_per_year?.value ?? 0,
      lifeYears: m7.equipment_life_years?.value ?? null,
    },
    assumptions: assumptionsChips(),
    live: P.live,
    liveProgress: P.progress,
    yearRows,
    nearestBench: nearestBenchmark(subject.lat, subject.lon),
    stakeholders: stakeholdersFor(P, center),
    ownLoss: P.live?.ownLoss ?? null,
    inCompare: state.compareList.some((c) => Math.abs(c.lat - subject.lat) < 1e-6 && Math.abs(c.lon - subject.lon) < 1e-6),
  };
}

function renderPassportNow() {
  const P = state.passport;
  if (!P) return;
  const container = document.getElementById('passport');
  const vm = buildPassportVm(P);
  if (!vm) {
    container.hidden = false;
    container.innerHTML = `<div class="card pp-loading"><h2>${esc(P.subject.title)}</h2><p>${esc(P.progress?.text || 'Считаю прогноз…')}</p><div class="pp-progress-bar"><i style="width:${Math.round((P.progress?.fraction || 0.02) * 100)}%"></i></div></div>`;
    return;
  }
  P.vm = vm;
  container.hidden = false;
  renderPassport(container, vm);
  wirePassport(P);
}

function wirePassport(P) {
  document.getElementById('pp-print').addEventListener('click', () => window.print());
  document.getElementById('pp-copy').addEventListener('click', async (e) => {
    const vm = P.vm;
    const text = [
      `${vm.subject.title} — ${vm.subject.subtitle}`,
      vm.subject.address ? `Адрес: ${vm.subject.address}` : null,
      `Координаты: ${vm.subject.lat.toFixed(6)}, ${vm.subject.lon.toFixed(6)}`,
      'Станция: DC150-2, 150 кВт, 2 поста',
      `Запрашиваемая мощность: 150 кВт`,
      `Подстанция 0,4 кВ: ${vm.dist04 !== null ? `${vm.dist04} м` : 'нет данных ближе 200 м'}`,
      vm.center ? `Питающий центр: ${vm.center.id}` : null,
      `Прогноз на ${vm.year}: ${num(vm.S[vm.year], 0)} зарядок в сутки (${vm.scenarioLabel})`,
    ]
      .filter(Boolean)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      e.target.textContent = 'Скопировано ✓';
    } catch {
      e.target.textContent = 'Не удалось скопировать';
    }
  });
  document.getElementById('pp-compare').addEventListener('click', (e) => {
    addToCompare(P.subject.lat, P.subject.lon, P.subject.title);
    e.target.textContent = 'Уже в сравнении';
  });
  document.querySelectorAll('#pp-scenario button').forEach((b) => b.addEventListener('click', () => setControl('scenario', b.dataset.value)));
  document.querySelectorAll('#pp-year button').forEach((b) => b.addEventListener('click', () => setControl('year', b.dataset.value)));
  document.getElementById('pp-subsidy').addEventListener('change', (e) => {
    P.subsidy = e.target.checked;
    renderPassportNow();
  });
  document.getElementById('pp-ampp')?.addEventListener('change', (e) => {
    P.ampp = e.target.checked;
    renderPassportNow();
  });
}

async function openPassport(subject) {
  const token = {};
  const subsidy = state.passport?.subsidy ?? false;
  const near = nearestAmpp(subject.lat, subject.lon);
  const ampp = state.ctl.funding === 'ampp' && !!near && near.m <= AMPP_M;
  state.passport = { subject, token, subsidy, ampp, progress: { fraction: 0.03, text: 'Считаю спрос, очередь и соседей…' }, live: null, e150: null };
  const P = state.passport;
  document.getElementById('passport-empty').hidden = true;
  renderPassportNow();
  window.scrollTo({ top: 0 });

  // Правообладатель площадки ещё не известен (у пула нет разметки) - спросить объект в точке.
  if (!subject.owner && !subject.geocode) {
    reverseGeocode(subject.lat, subject.lon).then((g) => {
      if (state.passport !== P || !g?.osm) return;
      subject.osm = g.osm;
      subject.owner = ownerOf(g.osm, { kind: subject.siteKind, siteName: subject.siteTitle });
      renderPassportNow();
    });
  }
  if (subject.geocode && !subject.address) {
    reverseGeocode(subject.lat, subject.lon).then((g) => {
      if (state.passport !== P || !g) return;
      subject.address = g.address;
      if (g.owner) subject.owner = g.owner;
      if (g.osm) subject.osm = g.osm;
      if (g.area) subject.subtitle = subject.kind === 'pt' ? g.area : `${g.area} · ${subject.subtitle}`;
      renderPassportNow();
    });
  }

  const m5 = state.params.M5_grid;
  P.thB = thresholds({ params: state.params, cfg: cfg150(), connCostRub: ((m5.c_B_rub_per_kW.min + m5.c_B_rub_per_kW.max) / 2) * 150, subsidy: P.subsidy });

  await nextFrame();
  if (state.passport !== P) return;
  const { scenario, year, season, dayType } = state.ctl;
  const candidateBase = { id: 'CANDIDATE', lat: subject.lat, lon: subject.lon, operator: 'РСЗС', status: 'candidate' };
  const cfg = cfg150();
  // Быстрая часть (М1-М4) на текущий день, сезон и год: профиль по часам и соседи.
  const candidate = { ...candidateBase, P_kW: cfg.P_cap_kW, posts: cfg.posts, P_post_kW: cfg.P_post_kW, year_open: year };
  const local = localEquilibrium({ cells: state.cells, stations: state.stations, candidate, params: state.preciseParams, year, scenario, dayType, season, fullContext: state.fullContext, fullResult: state.fullResult });
  P.live = liveFromLocal(local, candidate);
  P.dist04 = state.tp04 ? dist04FromKnownTp(subject.lat, subject.lon, state.tp04) : null;
  P.progress = { fraction: 0.08, text: 'Подбираю оборудование и считаю экономику…' };
  renderPassportNow();
  renderNeighbors({ neighborsSource: state.layers.neighborsSource, stations: state.stations, neighborDeltas: P.live.neighbors.map((n) => ({ globalIdx: n.globalJ, deltaS: n.deltaS })) });

  let evalResult;
  try {
    evalResult = await evaluateCandidateAsync({
      candidateBase,
      cells: state.cells,
      centers: state.centers,
      params: state.preciseParams,
      getBaseline: (y, s, d) => getBaseline(y, s, d, scenario),
      dist04Meters: P.dist04,
      scenario,
      years: [2026, 2028, 2030],
      onProgress: (done, total) => {
        if (state.passport !== P) throw new Error('cancelled');
        const nCfg = total / 12;
        P.progress = { fraction: 0.08 + 0.92 * (done / total), text: `Подбираю оборудование: вариант ${Math.min(nCfg, Math.floor((done - 1) / 12) + 1)} из ${nCfg} · 2026, 2028 и 2030, зима и лето` };
        const bar = document.querySelector('#passport .pp-progress-bar i');
        if (bar) bar.style.width = `${Math.round(P.progress.fraction * 100)}%`;
        const label = document.querySelector('#passport .pp-progress span');
        if (label) label.textContent = P.progress.text;
      },
    });
  } catch (err) {
    if (err.message === 'cancelled') return;
    throw err;
  }
  if (state.passport !== P) return;
  P.evalResult = evalResult;
  P.e150 = evalResult.evaluated.find((e) => e.cfg.omega === EQUIPMENT && !e.cfg.isBal) || null;
  P.live.equipmentRows = equipmentRows(evalResult);
  await benchmarkStats();
  if (state.passport !== P) return;
  P.progress = null;
  renderPassportNow();
}

function liveFromLocal(local, candidate) {
  const idx = local.candidateLocalIdx;
  const hourly = Array.from({ length: 24 }, (_, h) => SEGMENTS.reduce((a, s) => a + local.combined.bySegment[s][idx * 24 + h] * (1 - local.qh.L[idx * 24 + h]), 0));
  const Uh = Array.from({ length: 24 }, (_, h) => local.qh.U[idx * 24 + h]);
  const Wh = Array.from({ length: 24 }, (_, h) => local.qh.W[idx * 24 + h]);
  const Acch = Array.from({ length: 24 }, (_, h) => local.qh.Acc[idx * 24 + h]);
  let peakHour = 0;
  let worstHour = 0;
  for (let h = 0; h < 24; h++) {
    if (hourly[h] > hourly[peakHour]) peakHour = h;
    if (Acch[h] < Acch[worstHour]) worstHour = h;
  }
  const Snew = local.S_local[idx];
  let arr = 0;
  let srv = 0;
  for (let h = 0; h < 24; h++) {
    for (const s of SEGMENTS) arr += local.combined.bySegment[s][idx * 24 + h];
    srv += local.qh.lambdaSrv[idx * 24 + h];
  }
  const neighbors = [];
  local.affectedStationIdx.forEach((globalJ, localJ) => {
    const deltaS = local.S_local[localJ] - state.baselineS[globalJ];
    const st = state.stations[globalJ];
    if (Math.abs(deltaS) >= 0.05) neighbors.push({ globalJ, label: st.status === 'planned' ? 'Плановая станция города' : `${!st.operator || st.operator === 'независимый' ? 'Станция без сети' : st.operator}${st.address ? ` · ${st.address}` : ''}`, S0: state.baselineS[globalJ], deltaS });
  });
  neighbors.sort((a, b) => a.deltaS - b.deltaS);
  const cannibalization = neighbors.filter((n) => n.deltaS < 0).reduce((a, n) => a - n.deltaS, 0);
  // Сколько точка забирает у станций самой РСЗС (слайд 22: «РСЗС теряет 1,3 сессии»).
  const ownLoss = neighbors.filter((n) => n.deltaS < 0 && state.stations[n.globalJ].operator === candidate.operator).reduce((a, n) => a - n.deltaS, 0);
  const newDemand = -local.deltaLambdaOut - local.deltaLambdaLost;
  const { dayType, season, year, scenario } = state.ctl;
  return {
    hourly,
    peakHour,
    Snew,
    neighbors,
    cannibalization,
    ownLoss,
    newDemand,
    conditions: `${dayType === 'weekend' ? 'Выходной' : 'Будний день'}, ${season === 'winter' ? 'зима' : 'лето'} ${year}, ${SCENARIO_LABEL[scenario]}`,
    hourNote: (h) => `Больше всего машин в ${peakHour}:00. В ${h}:00 пост занят ${num(Uh[h] * 100, 0)}% времени, ждать в среднем ${num(Wh[h] * 60, 0)} мин. Другой час, день или сезон — в слое «Спрос по часам» на карте.`,
    tech: [
      ['Обслужено сессий в сутки, S_new', num(Snew, 2)],
      ['Доля отказов за сутки, p_K', `${num(arr > 0 ? ((arr - srv) / arr) * 100 : 0, 1)}%`],
      ['Худший час по доступности, Acc', `${worstHour}:00 — ${num(Acch[worstHour] * 100, 1)}%`],
      ['Каннибализация', `${num(Snew > 0 ? (cannibalization / Snew) * 100 : 0, 1)}%`],
      ['Потери станций РСЗС', `${num(ownLoss, 2)} в сутки`],
      ['Изменение «уехали без зарядки», ΔΛ_out', num(local.deltaLambdaOut, 2)],
      ['Изменение «ушли из-за очереди», ΔΛ_lost', num(local.deltaLambdaLost, 2)],
      ['Точка', `${candidate.lat.toFixed(5)}, ${candidate.lon.toFixed(5)}`],
    ],
    equipmentRows: null,
  };
}

function equipmentRows(evalResult) {
  const rec = evalResult.recommended;
  return evalResult.evaluated
    .filter((e) => !e.cfg.isBal)
    .map((e) => {
      const a = yearAverage(e, 2026);
      const b = yearAverage(e, 2030);
      const isRec = rec && e.cfg.omega === rec.cfg.omega;
      return `<tr class="${isRec ? 'rec' : ''} ${e.cls === 'В' ? 'blocked' : ''}">
        <td>${e.cfg.omega}${e.cfg.omega === EQUIPMENT ? ' <span class="tag">стандарт</span>' : ''}</td>
        <td>${e.cls}</td>
        <td class="num">${num(a.sessions, 1)} → ${num(b.sessions, 1)}</td>
        <td class="num">+${num(a.gain, 1)} → +${num(b.gain, 1)}</td>
        <td class="num">${e.scenarios ? num(newClientsPerMln(e), 2) : '—'}</td>
        <td class="num">${e.scenarios ? num(e.scenarios.low.NPVrub / 1e6, 1) : '—'}</td>
      </tr>`;
    })
    .join('');
}

// ---------- Сравнение: свои точки с баллами ----------
function scoreFor(c) {
  return scoreCandidateRaw({ candidate: { lat: c.lat, lon: c.lon }, cells: state.cells, stations: state.stations, centers: state.centers, params: state.preciseParams, demand: state.fullResult.demand, tp04: state.tp04 });
}

function addToCompare(lat, lon, label) {
  if (state.compareList.some((c) => Math.abs(c.lat - lat) < 1e-6 && Math.abs(c.lon - lon) < 1e-6)) return;
  const entry = { listId: state.compareNextId++, lat, lon, label };
  state.compareList.push({ ...entry, ...scoreFor(entry) });
  renderCompareList();
}

function renderCompareList() {
  const wrap = document.getElementById('candidate-list-wrap');
  document.getElementById('candidate-list-empty').hidden = state.compareList.length > 0;
  wrap.hidden = state.compareList.length === 0;
  const { key: rawKey, dir } = state.compareSort;
  const key = rawKey === 'index' ? 'listId' : rawKey;
  const rows = normalizeAndScore(state.compareList).sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    return dir === 'asc' ? av - bv : bv - av;
  });
  const tbody = document.getElementById('candidate-list-body');
  tbody.innerHTML = rows
    .map(
      (c, i) => `<tr data-list-id="${c.listId}">
        <td>${i + 1}</td>
        <td><b class="score">${c.composite.toFixed(0)}</b><div class="score-raw">${esc(c.label || '')}</div></td>
        <td><b>${c.powerScore.toFixed(0)}</b><div class="score-raw">${c.pAvailKW < 150 ? 'нет свободной мощности' : c.dist04 !== null ? `подстанция в ${c.dist04} м, класс А` : 'подстанции ближе 200 м нет, класс Б'}</div></td>
        <td><b>${c.trafficScore.toFixed(0)}</b><div class="score-raw">≈ ${Math.round(c.trafficRaw)} в сутки</div></td>
        <td><b>${c.competitionScore.toFixed(0)}</b><div class="score-raw">${c.nearbyCount} ${plural(c.nearbyCount, 'станция', 'станции', 'станций')} рядом</div></td>
        <td>${esc(c.district)}</td>
        <td><button class="remove-btn" data-remove-id="${c.listId}" title="Убрать">✕</button></td>
      </tr>`
    )
    .join('');
  tbody.querySelectorAll('tr').forEach((tr) =>
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.remove-btn')) return;
      const c = state.compareList.find((x) => x.listId === Number(tr.dataset.listId));
      if (c) location.hash = `#passport/pt/${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
    })
  );
  tbody.querySelectorAll('.remove-btn').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      state.compareList = state.compareList.filter((c) => c.listId !== Number(b.dataset.removeId));
      renderCompareList();
    })
  );
}

function wireCompareSorting() {
  document.querySelectorAll('#candidate-list-table th[data-sort]').forEach((th) =>
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      state.compareSort = state.compareSort.key === key ? { key, dir: state.compareSort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' };
      renderCompareList();
    })
  );
}

// ---------- Модуль 8: модель против традиционного выбора ----------
const fmtPct = (x) => (x === null || x === undefined ? '—' : `${num(x * 100, 1)}%`);

function renderHeroKpis() {
  const pf = state.portfolio;
  const my = pf.metrics_by_year?.[2026];
  if (!my || !pf.model?.picks?.length) return;
  const ex = (k) => my[k].sessions_per_day_network - my.baseline.sessions_per_day_network;
  const capex = (picks) => picks.reduce((a, p) => a + (p.capex_rub || 0), 0);
  const perMln = (picks) => picks.reduce((a, p) => a + ((p.new_demand_2026 || 0) + (p.new_demand_2030 || 0)) / 2, 0) / Math.max(1e-9, capex(picks) / 1e6);
  const mPicks = pf.model.picks;
  const tPicks = pf.traditional.picks;
  const ratio = perMln(tPicks) > 0 ? perMln(mPicks) / perMln(tPicks) : null;
  const clsA = mPicks.filter((p) => p.cls === 'А').length;
  const el = document.getElementById('hero-kpis');
  el.innerHTML = `
    <div class="kpi"><div class="kpi-label">Новых клиентов в сутки, 2026</div><div class="kpi-value">+${Math.round(ex('model'))}</div><div class="kpi-sub">дадут ${mPicks.length} станций, выбранных моделью · при обычном выборе ${ex('traditional') >= 0 ? '+' : '−'}${Math.abs(Math.round(ex('traditional')))}</div></div>
    <div class="kpi"><div class="kpi-label">Новых клиентов на рубль</div><div class="kpi-value">${ratio ? `×${num(ratio, 1)}` : '—'}</div><div class="kpi-sub">${num(capex(mPicks) / 1e6, 0)} млн ₽ вместо ${num(capex(tPicks) / 1e6, 0)} млн ₽</div></div>
    <div class="kpi"><div class="kpi-label">Дешёвое подключение</div><div class="kpi-value">${clsA}/${mPicks.length}</div><div class="kpi-sub">мест с подстанцией ближе 200 м (класс А)</div></div>`;
  el.hidden = false;
}

// Пример в «Методике» - первая рекомендация портфеля (номер и цифры из
// portfolio.json, обновляются при пересчёте).
const HOW_EXAMPLE_ID = null;
function renderHowExample() {
  const picks = state.portfolio?.model?.picks || [];
  const rank = picks.findIndex((x) => x.id === HOW_EXAMPLE_ID);
  const p = picks[rank >= 0 ? rank : 0];
  if (!p || p.sessions_2026 == null || p.new_demand_2026 == null) return;
  const site = state.siteById.get(p.id);
  document.getElementById('how-example-title').textContent = `Пример: кандидат №${rank >= 0 ? rank + 1 : 1}${site?.area ? `, ${site.area}` : ''}`;
  const stolen = Math.max(0, p.sessions_2026 - p.new_demand_2026);
  const conn = p.conn_cost_high_rub ? ` Подключение к электросети: класс ${esc(p.cls)}, около ${num(p.conn_cost_low_rub / 1e6, 1)}–${num(p.conn_cost_high_rub / 1e6, 1)} млн ₽.` : '';
  document.getElementById('how-example-body').innerHTML =
    `<p>${esc(p.kind[0].toUpperCase() + p.kind.slice(1))} в ${esc(p.district)}. В 2026 году станция там будет заряжать около ${num(p.sessions_2026, 1)} машин в сутки. Из них:</p>
    <div class="how-split">
      <div class="how-split-new"><b>${num(p.new_demand_2026, 1)}</b> новые клиенты: раньше они уезжали без зарядки или не дожидались очереди</div>
      <div class="how-split-old"><b>${num(stolen, 1)}</b> перешли с соседних станций, для сети в целом это не прибавка</div>
    </div>
    <p>${p.new_demand_2030 < p.new_demand_2026 / 2 ? `К 2030 году новых клиентов у этой станции почти не останется (${num(p.new_demand_2030, 1)} в сутки): город поставит свои станции. Поэтому ставить станцию выгодно сейчас.` : `К 2030 году новых клиентов у этой станции станет ${num(p.new_demand_2030, 1)}.`} Модель выбирает места по числу новых клиентов в 2026 и 2030 годах.${conn}</p>`;
  document.getElementById('how-example').hidden = false;
}

// Эффект инструмента в рублях (ТЗ по метрикам, уровень 3): NPV портфеля,
// индекс доходности, доля окупаемых за норматив площадок и стоимость ошибок -
// сумма отрицательных NPV. По каждой площадке - отдельная станция DC150-2 из
// zones.json (решение в 2026, 10 лет, 18%), выбранный сценарий.
function portfolioMoney() {
  const pf = state.portfolio;
  const scenario = state.ctl.scenario;
  const N = state.th.normYears;
  const calc = (picks) => {
    const rows = picks.map((p) => ({ p, by: state.siteById.get(p.id)?.calc?.by?.[scenario] })).filter((x) => x.by?.npv);
    const npvHi = rows.reduce((a, x) => a + x.by.npv[0], 0);
    const npvLo = rows.reduce((a, x) => a + x.by.npv[1], 0);
    const capex = rows.reduce((a, x) => a + x.by.capex[1], 0);
    const paid = rows.filter((x) => x.by.payback?.[1] !== null && x.by.payback[1] <= N).length;
    const errors = rows.reduce((a, x) => a + Math.max(0, -x.by.npv[0]), 0);
    const losers = rows.filter((x) => x.by.npv[0] < 0).length;
    return { n: rows.length, npvHi, npvLo, capex, pi: capex > 0 ? 1 + npvHi / capex : null, paid, errors, losers };
  };
  const m = calc(pf.model?.picks || []);
  const t = calc(pf.traditional?.picks || []);
  const mlnS = (v) => `${v >= 0 ? '+' : '−'}${num(Math.abs(v) / 1e6, 1)}`;
  const row = (label, a, b, better) => `<tr><td>${label}</td><td class="num col-trad">${a}</td><td class="num col-model ${better ? 'better' : ''}">${b}</td></tr>`;
  document.getElementById('portfolio-money').innerHTML = `
    <table class="compare-table money-table">
      <thead><tr><th>Деньги. 10 станций по 150 кВт, решение в 2026 году, ${esc(SCENARIO_LABEL[scenario])}, 10 лет работы, ставка 18%</th><th class="col-trad">Традиционный подход</th><th class="col-model">Выбор по модели</th></tr></thead>
      <tbody>
        ${row('NPV 10 станций — если подключение дорогое', `${mlnS(t.npvHi)} млн ₽`, `${mlnS(m.npvHi)} млн ₽`, m.npvHi > t.npvHi)}
        ${row('NPV 10 станций — если подключение дешёвое', `${mlnS(t.npvLo)} млн ₽`, `${mlnS(m.npvLo)} млн ₽`, m.npvLo > t.npvLo)}
        ${row('<b>Модель выигрывает</b>', '', `<b>${mlnS(m.npvHi - t.npvHi)} млн ₽</b>`, m.npvHi > t.npvHi)}
        ${row('Сколько возвращается с каждого вложенного рубля (с учётом ставки)', `${num(t.pi, 2)} ₽`, `${num(m.pi, 2)} ₽`, m.pi > t.pi)}
        ${row(`Площадок, окупающихся за ${N} лет`, `${t.paid} из ${t.n}`, `${m.paid} из ${m.n}`, m.paid > t.paid)}
        ${row('Потери на местах, которые не окупаются', `${num(t.errors / 1e6, 1)} млн ₽`, `${num(m.errors / 1e6, 1)} млн ₽`, m.errors < t.errors)}
      </tbody>
    </table>
    <p class="hint">Каждая площадка посчитана как отдельная станция, без учёта того, что станции портфеля делят клиентов между собой, и без компенсации МФППиП. Стоимость ошибок — сколько потеряли бы станции с отрицательным NPV; разница между подходами — ошибки, которых модель позволяет избежать.</p>`;
}

function renderPortfolioPanel() {
  portfolioMoney();
  const pf = state.portfolio;
  const modelPicks = pf.model?.picks || [];
  document.getElementById('portfolio-subtitle').textContent = 'Модель выбрала 10 мест внутри МКАД из 300 реальных площадок. Ниже они сравниваются с местами, которые дал бы обычный способ выбора: много магазинов и кафе рядом, крупные дороги, мало загруженных соседей.';
  document.getElementById('portfolio-section').hidden = false;
  const my = pf.metrics_by_year;
  const compare = document.getElementById('portfolio-compare');
  if (my) {
    const fmtNum = (v, d = 1) => (v === null || v === undefined || !isFinite(v) ? '—' : num(v, d));
    const sign = (v) => (Math.abs(v) < 0.5 ? '0' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(0)}`);
    const years = [2026, 2028, 2030].filter((y) => my[y]);
    const ex = (y, k) => my[y][k].sessions_per_day_network - my[y].baseline.sessions_per_day_network;
    const m = my[2028] || my[years[0]];
    const b = m.baseline;
    const capex = (picks) => picks.reduce((a, p) => a + (p.capex_rub || 0), 0);
    const perMln = (picks) => picks.reduce((a, p) => a + ((p.new_demand_2026 || 0) + (p.new_demand_2030 || 0)) / 2, 0) / Math.max(1e-9, capex(picks) / 1e6);
    const fmtPp = (x, base) => `${fmtPct(x)} <span class="delta">(было ${fmtPct(base)})</span>`;
    const rows = [
      ['group', 'Новые клиенты: сколько зарядок в сутки добавят 10 новых станций'],
      ...years.map((y) => [`${y} год${y === 2028 ? ' (в 2027–2028 открываются городские станции и забирают часть спроса)' : ''}`, sign(ex(y, 'traditional')), sign(ex(y, 'model')), ex(y, 'model') > ex(y, 'traditional')]),
      ['group', 'Насколько заняты новые станции, 2028 год'],
      ['Загрузка постов: какую долю времени пост занят', fmtPct(m.traditional.U_new_mean), fmtPct(m.model.U_new_mean), m.model.U_new_mean > m.traditional.U_new_mean],
      ['Станций, занятых меньше 20% времени (меньше — лучше)', fmtPct(m.traditional.share_new_U_below_20), fmtPct(m.model.share_new_U_below_20), m.model.share_new_U_below_20 < m.traditional.share_new_U_below_20],
      ['group', 'Для водителей, 2028 год'],
      ['Сколько желающих зарядиться смогли это сделать', fmtPp(m.traditional.served_share_of_demand, b.served_share_of_demand), fmtPp(m.model.served_share_of_demand, b.served_share_of_demand), m.model.served_share_of_demand > m.traditional.served_share_of_demand],
      ['Уехали, потому что все посты были заняты', fmtPct(m.traditional.queue_loss_share), fmtPct(m.model.queue_loss_share), m.model.queue_loss_share < m.traditional.queue_loss_share - 0.0005],
      ['Ожидание в самый загруженный час, мин', fmtNum(m.traditional.wait_min_peak), fmtNum(m.model.wait_min_peak), m.model.wait_min_peak < m.traditional.wait_min_peak - 0.05],
      ['group', 'Деньги и подключение'],
      ['Вложения: станции, подключение, площадки', `${fmtNum(capex(pf.traditional.picks) / 1e6)} млн ₽`, `${fmtNum(capex(modelPicks) / 1e6)} млн ₽`, capex(modelPicks) < capex(pf.traditional.picks)],
      ['Новых клиентов в сутки на 1 млн ₽ (среднее за 2026 и 2030)', fmtNum(perMln(pf.traditional.picks), 2), fmtNum(perMln(modelPicks), 2), perMln(modelPicks) > perMln(pf.traditional.picks)],
      ['Мест с дешёвым подключением (класс А)', `${pf.traditional.picks.filter((p) => p.cls === 'А').length} из ${pf.traditional.picks.length}`, `${modelPicks.filter((p) => p.cls === 'А').length} из ${modelPicks.length}`, modelPicks.filter((p) => p.cls === 'А').length / Math.max(1, modelPicks.length) > pf.traditional.picks.filter((p) => p.cls === 'А').length / Math.max(1, pf.traditional.picks.length)],
    ];
    compare.innerHTML = `<table class="compare-table">
      <thead><tr><th>Средний день года, ${esc(SCENARIO_LABEL.base)}. У обоих подходов станции ${esc(pf.equipment || 'DC150-2')}. Галочка — лучший результат.</th><th class="col-trad">Традиционный подход</th><th class="col-model">Выбор по модели</th></tr></thead>
      <tbody>${rows.map((r) => (r[0] === 'group' ? `<tr class="group"><td colspan="3">${r[1]}</td></tr>` : `<tr><td>${r[0]}</td><td class="num col-trad">${r[1]}</td><td class="num col-model ${r[3] && modelPicks.length > 0 ? 'better' : ''}">${r[2]}</td></tr>`)).join('')}</tbody></table>`;
  }
  document.getElementById('portfolio-body').innerHTML = modelPicks
    .map((p, k) => {
      const site = state.siteById.get(p.id);
      return `<tr data-id="${esc(p.id)}">
        <td><span class="pin-num">${k + 1}</span></td>
        <td><div class="site-kind">${esc(p.id)} · ${esc(p.kind)}</div>${p.name ? `<div class="site-name">${esc(p.name)}</div>` : ''}${site?.address ? `<div class="site-name">${esc(site.address)}</div>` : ''}</td>
        <td>${esc(site?.area || '—')}<div class="site-name">${esc(p.district || '')}</div></td>
        <td class="num"><strong>+${num(p.new_demand_2026 ?? 0, 1)} → +${num(p.new_demand_2030 ?? 0, 1)}</strong></td>
        <td class="num">${num(p.sessions_2026 ?? 0, 1)} → ${num(p.sessions_2030 ?? 0, 1)}</td>
        <td>${esc(p.omega)} · класс ${esc(p.cls || '—')}<div class="site-name">${p.conn_cost_high_rub ? `подключение ${num(p.conn_cost_low_rub / 1e6, 1)}–${num(p.conn_cost_high_rub / 1e6, 1)} млн ₽` : ''}${p.dist04_m ? `, подстанция в ${p.dist04_m} м` : ''}</div></td>
      </tr>`;
    })
    .join('');
  document.querySelectorAll('#portfolio-body tr').forEach((tr) => tr.addEventListener('click', () => (location.hash = `#passport/site/${tr.dataset.id}`)));
  document.getElementById('portfolio-footnote').textContent =
    (pf.model?.stoppedReason ? `Модель остановилась раньше ${pf.N} станций: ${pf.model.stoppedReason}. ` : '') +
    (pf.traditional?.dropped?.length ? `Традиционный подход потерял ${pf.traditional.dropped.length} площадк(и): класс подключения В выяснился поздно. ` : '') +
    'Места выбраны по числу новых клиентов на 1 млн ₽ вложений, в среднем за 2026 и 2030 годы. Новые клиенты — зарядки, которых без станции не было бы. Вложения включают станцию, подключение и площадку, без субсидии. У обоих подходов одинаковые станции DC150-2, поэтому разница только в месте и цене подключения.';
}

// ---------- Тесты (раздел 13) ----------
async function runTests() {
  const btn = document.getElementById('run-tests-btn');
  const panel = document.getElementById('test-results');
  btn.disabled = true;
  panel.hidden = false;
  panel.innerHTML = '<p>Считаю тесты Т1–Т10 (около минуты)…</p>';
  await nextFrame();
  const rows = [];
  const renderRows = () => {
    panel.innerHTML = rows
      .map((r) => {
        const cls = r.pass ? 'pass' : r.pending ? 'pending' : r.soft ? 'soft-fail' : 'fail';
        const mark = r.pass ? '✓' : r.pending ? '⏳' : r.soft ? '⚠' : '✗';
        return `<div class="test-row"><span class="test-status ${cls}">${mark}</span><div><div>${r.name}</div><div class="test-detail">${r.detail}</div></div></div>`;
      })
      .join('');
  };
  try {
    // Тесты рассчитаны на сеть 2026 года (базовый сценарий, будни лета) - как в npm test.
    const base = getBaseline(2026, 'summer', 'weekday', 'base');
    const results = await runAllTests({
      cells: state.cells,
      stationsAll: state.stationsAll,
      stations: base.stations,
      params: state.preciseParams,
      fullContext: base.context,
      fullResult: base.result,
      onProgress: (r) => {
        rows.push(r);
        renderRows();
      },
    });
    const run = results.filter((r) => !r.pending);
    const hardFails = run.filter((r) => !r.pass && !r.soft);
    const softFails = run.filter((r) => !r.pass && r.soft);
    const pending = results.filter((r) => r.pending);
    const uniq = (list) => [...new Set(list.map((r) => r.id))];
    const summary =
      (hardFails.length === 0 ? `Пройдены все ${uniq(run).length} тестов${softFails.length ? `. Ожидаемо мягкий результат: ${softFails.map((r) => r.name.replace(/^Т\d+: /, '')).join('; ')} — при слабой загрузке сети время суток почти не влияет на выбор (раздел 14 спецификации)` : ''}` : `Не пройдено: ${uniq(hardFails).map((id) => id.replace('T', 'Т')).join(', ')}`) +
      (pending.length ? `. Ждут данных от заказчика: ${pending.map((r) => r.id.replace('T', 'Т')).join(', ')}` : '');
    panel.innerHTML += `<div class="test-summary ${hardFails.length ? 'bad' : 'good'}">${summary}</div>`;
  } catch (err) {
    console.error(err);
    panel.innerHTML += `<div class="test-summary bad">Ошибка при прогоне тестов: ${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- Управление: сценарий, год, день, сезон ----------
let recomputeTimer = null;
function setControl(name, value) {
  const v = name === 'year' ? Number(value) : value;
  if (state.ctl[name] === v) return;
  state.ctl[name] = v;
  document.querySelectorAll(`.seg[data-control="${name}"] button`).forEach((b) => b.classList.toggle('active', b.dataset.value === String(v)));
  if (name === 'scenario' || name === 'year' || name === 'funding') renderZonesView();
  if (name === 'funding') {
    if (state.passport) {
      const near = nearestAmpp(state.passport.subject.lat, state.passport.subject.lon);
      state.passport.ampp = v === 'ampp' && !!near && near.m <= AMPP_M;
      if (currentView() === 'passport') renderPassportNow();
    }
    return;
  }
  if (name === 'scenario' && state.portfolio) portfolioMoney();
  const onPassport = state.passport && currentView() === 'passport';
  // Паспорт сразу показывает готовый расчёт зон для нового сценария, точный
  // пересчёт запускается после пересчёта сети.
  if (onPassport && name === 'scenario') {
    state.passport.e150 = null;
    state.passport.evalResult = null;
    state.passport.live = null;
    state.passport.progress = { fraction: 0.02, text: 'Пересчитываю сеть под новый сценарий…' };
  }
  if (onPassport) renderPassportNow();
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(async () => {
    await recomputeFullEquilibrium();
    // Паспорт открыт - пересчитать под новые условия.
    if (onPassport && name === 'scenario') openPassport(state.passport.subject);
  }, 120);
}

function wireControls() {
  document.querySelectorAll('.seg[data-control]').forEach((seg) =>
    seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setControl(seg.dataset.control, b.dataset.value)))
  );
  document.getElementById('hour-slider').addEventListener('input', (e) => {
    state.ctl.hour = Number(e.target.value);
    rerenderMapForHour();
  });
  const L = state.layers;
  const zonesBox = document.getElementById('layer-zones');
  zonesBox.addEventListener('change', () => L.zonesLayer.setVisible(zonesBox.checked));
  document.getElementById('layer-stations').addEventListener('change', (e) => L.stationsLayer.setVisible(e.target.checked));
  document.getElementById('layer-bench').addEventListener('change', (e) => showBenchmarkLayer(e.target.checked));
  document.getElementById('layer-centers').addEventListener('change', (e) => L.centersLayer.setVisible(e.target.checked));
  document.getElementById('toggle-model').addEventListener('change', redrawPortfolioPins);
  document.getElementById('toggle-trad').addEventListener('change', redrawPortfolioPins);
  document.getElementById('layer-demand').addEventListener('change', (e) => {
    const on = e.target.checked;
    document.getElementById('demand-controls').hidden = !on;
    document.getElementById('map-legend').hidden = !on;
    document.getElementById('zone-legend').hidden = on;
    // Спрос по часам и зоны решения на одной карте не читаются - зоны прячем.
    if (on) state.zonesWereOn = zonesBox.checked;
    zonesBox.checked = on ? false : state.zonesWereOn ?? true;
    L.zonesLayer.setVisible(zonesBox.checked);
    L.demandLayer.setVisible(on);
    if (on) rerenderMapForHour();
  });
  document.getElementById('toggle-slow').addEventListener('change', async (e) => {
    if (e.target.checked && L.slowSource.getFeatures().length === 0) {
      const slow = await loadSlowStations();
      renderSlowStations({ slowSource: L.slowSource, stations: slow });
      document.getElementById('slow-count').textContent = ` (${slow.length})`;
    }
    L.slowLayer.setVisible(e.target.checked);
  });
  const toggle = document.getElementById('layers-toggle');
  toggle.addEventListener('click', () => {
    const body = document.getElementById('layers-body');
    body.hidden = !body.hidden;
    toggle.setAttribute('aria-expanded', String(!body.hidden));
  });
  if (window.matchMedia('(max-width: 720px)').matches) toggle.click();
  document.getElementById('check-point-btn').addEventListener('click', () => {
    setCheckMode(!state.checkMode);
    if (state.checkMode) document.querySelector('.map-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.checkMode) setCheckMode(false);
  });
  document.getElementById('run-tests-btn').addEventListener('click', runTests);
  wireCompareSorting();
  wireSearch();
  wirePopup();
}

// ---------- Роутинг ----------
const VIEWS = ['map', 'passport', 'compare', 'method'];
const currentView = () => (location.hash.slice(1).split('/')[0] || 'map');

function showView(view) {
  if (!VIEWS.includes(view)) view = 'map';
  for (const v of VIEWS) document.getElementById(`view-${v}`).hidden = v !== view;
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  if (view === 'map') requestAnimationFrame(() => state.layers.map.updateSize());
}

function route() {
  const [view, ...rest] = location.hash.slice(1).split('/');
  const v = VIEWS.includes(view) ? view : 'map';
  showView(v);
  if (v === 'passport') {
    if (!rest.length) {
      if (!state.passport) {
        document.getElementById('passport-empty').hidden = false;
        document.getElementById('passport').hidden = true;
      }
      return;
    }
    const subject = subjectFromRoute(rest);
    if (!subject) {
      document.getElementById('passport-empty').hidden = false;
      document.getElementById('passport').hidden = true;
      return;
    }
    const same = state.passport && state.passport.subject.kind === subject.kind && state.passport.subject.id === subject.id;
    if (!same) openPassport(subject);
    else window.scrollTo({ top: 0 });
  } else window.scrollTo({ top: 0 });
}

// ---------- Старт ----------
async function main() {
  const { ampp, taxiStands, cells, stationsAll, centers, params, zones, pool, tp04, tp04Meta, mkadRing, benchmarks } = await loadData();
  state.amppIndex = ampp.length ? buildAmppIndex(ampp) : null;
  state.taxiStands = taxiStands;
  state.tp04Meta = tp04Meta;
  state.benchmarks = benchmarks;
  const preciseParams = { ...params, equilibrium: { ...params.equilibrium, convergence_threshold_hours: params.equilibrium.convergence_threshold_hours_precise } };
  Object.assign(state, { cells, stationsAll, centers, params, preciseParams, zones, tp04, mkadRing });
  const calcById = new Map(zones.sites.map((s) => [s.id, s]));
  for (const s of pool) state.siteById.set(s.id, { ...s, calc: calcById.get(s.id) || null });
  // расстояние до парковки АМПП - в расчёт каждого сценария (для статуса в режиме «по АМПП»)
  const tagAmpp = (lat, lon, byAll, maxM) => {
    const m = nearestAmpp(lat, lon)?.m ?? null;
    for (const by of Object.values(byAll || {})) {
      by.amppM = m;
      by.amppOk = m !== null && m <= maxM;
    }
  };
  for (const z of zones.zones) tagAmpp(z.lat, z.lon, z.by, AMPP_ZONE_M);
  for (const s of state.siteById.values()) if (s.calc) tagAmpp(s.lat, s.lon, s.calc.by, AMPP_M);
  computeThresholds();
  document.getElementById('stations-count').textContent = String(stationsAll.filter((st) => st.status !== 'planned' && !st.outside_mkad).length);
  document.getElementById('data-chip').textContent = `Расчёт зон ${new Date(zones.date).toLocaleDateString('ru-RU')}`;

  state.layers = initMap();
  renderCentersLayer({ centersSource: state.layers.centersSource, centers });
  renderMkad({ mkadSource: state.layers.mkadSource, ring: mkadRing });
  state.layers.map.on('singleclick', onMapClick);

  try {
    state.portfolio = await fetchJson('data/portfolio.json');
  } catch {
    state.portfolio = null;
  }
  buildCandidates();

  await recomputeFullEquilibrium();
  document.getElementById('loading').hidden = true;
  document.getElementById('app').hidden = false;
  renderZonesView();
  wireControls();
  if (state.portfolio) {
    renderPortfolioPanel();
    renderHeroKpis();
    renderHowExample();
  }
  window.addEventListener('hashchange', route);
  route();
  state.layers.map.updateSize();
}

main().catch((err) => {
  console.error(err);
  document.getElementById('loading').innerHTML = `<p>Ошибка загрузки: ${esc(err.message)}</p>`;
});
