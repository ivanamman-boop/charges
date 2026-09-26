// Точка входа статического сайта. Оркестрирует загрузку данных, карту,
// ползунок времени и черновик паспорта площадки (клик по карте).
import { SEGMENTS, demandField } from './demand.js';
import { buildNetworkContext, equilibrium, localEquilibrium, dailySessions } from './equilibrium.js';
import { evaluateCandidateAsync } from './equipment.js';
import { initMap, renderDemandLayer, renderStationsLayer, renderCentersLayer, renderCandidate, renderNeighbors, coordToLatLng, clusterExtentAtPixel, renderPortfolio, portfolioPickAtPixel, renderMkad, renderSlowStations } from './mapview.js';
import { renderPassport, renderEquipment } from './passport.js';
import { runAllTests } from './tests.js';
import { scoreCandidateRaw, normalizeAndScore } from './scoring.js';
import { dist04FromKnownTp } from './grid.js';

const DATA_FILES = ['cells', 'stations', 'centers', 'params'];

async function loadData() {
  const [cellsRaw, stationsRaw, centersRaw, params] = await Promise.all(
    DATA_FILES.map((name) => fetch(`data/${name}.json`).then((r) => r.json()))
  );
  return {
    cells: cellsRaw.cells,
    stationsAll: stationsRaw.stations,
    centers: centersRaw.centers,
    params,
    raw: { cellsRaw, stationsRaw, centersRaw, params },
  };
}

function setStatus(msg, kind = 'ok') {
  const el = document.getElementById('recompute-status');
  el.textContent = msg;
  el.dataset.kind = kind;
}

const state = {
  cells: null,
  stationsAll: null,
  centers: null,
  params: null, // как загружено из params.json (грубый порог сходимости)
  preciseParams: null, // тот же params, но с точным порогом (12.3, journal.md 20.09) - для всего, что считает ΔS/каннибализацию/экономику
  stations: null, // активные в текущем году
  fullContext: null,
  fullResult: null,
  baselineS: null,
  baselineCache: new Map(), // "год|сезон|деньТипа" -> {context, result, stations}, для equipment.js
  candidate: null,
  localResult: null,
  layers: null,
  candidateList: [], // список площадок с баллами (фидбек Росатома), см. js/scoring.js
  candidateListNextId: 1,
  candidateListSort: { key: 'composite', dir: 'desc' },
  activeListId: null,
  mkadRing: null, // data/mkad.json - граница модели
  tp04: null, // data/tp04.json - известные ТП 0.4 кВ для класса подключения (7.2)
  portfolio: null, // data/portfolio.json (модуль 8, считается офлайн: npm run compute:portfolio)
};

function readControls() {
  return {
    hour: Number(document.getElementById('hour-slider').value),
    dayType: document.getElementById('day-type-select').value,
    season: document.getElementById('season-select').value,
    year: Number(document.getElementById('year-slider').value),
    scenario: document.getElementById('scenario-select').value,
  };
}

function totalDemandPerCellAtHour(demand, nCells, hour) {
  const arr = new Float64Array(nCells);
  for (const s of SEGMENTS) {
    const d = demand[s];
    for (let i = 0; i < nCells; i++) arr[i] += d[i * 24 + hour];
  }
  return arr;
}

// Час с максимальным суммарным спросом по городу - по нему фиксируется
// шкала зон спроса на карте (см. renderDemandLayer).
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

// Суммарный спрос по городу в пиковый час - для абсолютной насыщенности
// карты спроса и подписи в легенде.
function cityPeakDemand(demand, nCells) {
  const h = peakDemandHour(demand, nCells);
  let sum = 0;
  for (const s of SEGMENTS) for (let i = 0; i < nCells; i++) sum += demand[s][i * 24 + h];
  return sum;
}

// Границы шкалы насыщенности: самая слабая комбинация (2026, лето, выходной)
// и самая сильная (2030, зима, будни) в текущем сценарии. Считается один раз
// на сценарий - demandField дешёвый, без равновесия.
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
  const { hour } = readControls();
  document.getElementById('hour-label').textContent = `${String(hour).padStart(2, '0')}:00`;

  const { fullResult, cells, stations } = state;
  const Uarr = new Float64Array(stations.length);
  for (let j = 0; j < stations.length; j++) Uarr[j] = fullResult.qh.U[j * 24 + hour];

  renderStationsLayer({
    stationsSource: state.layers.stationsSource,
    stations,
    activeStations: fullResult.activeStations,
    Uarr,
    onClickStation: null,
  });
  const bounds = demandBounds(readControls().scenario);
  const cityPeak = cityPeakDemand(fullResult.demand, cells.length);
  const intensity = Math.log(cityPeak / bounds.lo) / Math.log(bounds.hi / bounds.lo);
  renderDemandLayer({
    demandSource: state.layers.demandSource,
    cells,
    totalDemandPerCell: totalDemandPerCellAtHour(fullResult.demand, cells.length, hour),
    scaleDemandPerCell: totalDemandPerCellAtHour(fullResult.demand, cells.length, peakDemandHour(fullResult.demand, cells.length)),
    intensity,
  });
  const dayLabel = readControls().dayType === 'weekend' ? 'выходной' : 'будни';
  document.getElementById('map-legend-time').textContent = `${String(hour).padStart(2, '0')}:00 · ${dayLabel}`;
  const k = cityPeak / bounds.base2026;
  document.getElementById('map-legend-volume').textContent =
    `в пик по городу ${Math.round(cityPeak).toLocaleString('ru-RU')} заявок/ч` + (Math.abs(k - 1) > 0.05 ? ` · ×${k < 10 ? k.toFixed(1).replace('.', ',') : Math.round(k)} к зиме 2026` : '');
}

// Опорное равновесие для equipment.js (module 6, до 8 комбинаций год x сезон
// x день). Кэшируется, чтобы повторный подбор оборудования не пересчитывал
// то, что уже считали (12.3: "опорные равновесия... кэшируются").
function getBaseline(year, season, dayType) {
  const key = `${year}|${season}|${dayType}`;
  if (state.baselineCache.has(key)) return state.baselineCache.get(key);
  const stations = state.stationsAll.filter((s) => s.year_open <= year);
  const context = buildNetworkContext({ cells: state.cells, stations, params: state.preciseParams });
  const result = equilibrium({ cells: state.cells, stations, params: state.preciseParams, year, scenario: 'base', dayType, season, context });
  const entry = { context, result, stations };
  state.baselineCache.set(key, entry);
  return entry;
}

async function recomputeFullEquilibrium() {
  setStatus('Пересчитываю сеть…', 'busy');
  await new Promise((r) => setTimeout(r, 0)); // дать браузеру отрисовать статус

  const { dayType, season, year, scenario } = readControls();
  const t0 = performance.now();

  state.stations = state.stationsAll.filter((s) => s.year_open <= year);
  state.fullContext = buildNetworkContext({ cells: state.cells, stations: state.stations, params: state.preciseParams });
  state.fullResult = equilibrium({
    cells: state.cells,
    stations: state.stations,
    params: state.preciseParams,
    year,
    scenario,
    dayType,
    season,
    context: state.fullContext,
  });
  state.baselineS = dailySessions(state.fullResult.qh.lambdaSrv, state.stations.length);

  // Тот же расчёт годится и как опорное равновесие для equipment.js (только
  // для сценария base - см. ограничение в reference-equilibria.json).
  if (scenario === 'base') {
    state.baselineCache.set(`${year}|${season}|${dayType}`, { context: state.fullContext, result: state.fullResult, stations: state.stations });
  }

  const ms = Math.round(performance.now() - t0);
  console.log(`равновесие сети: ${ms} мс, ${state.fullResult.it} итераций`);
  setStatus(state.fullResult.converged ? 'Сеть пересчитана' : 'Расчёт не сошёлся — результат приблизительный', state.fullResult.converged ? 'ok' : 'warn');

  rerenderMapForHour();

  // Выбранная точка остаётся выбранной - её прогноз пересчитывается под
  // новые условия (день, сезон, год, сценарий), а не сбрасывается.
  if (state.candidate) {
    placeCandidateAndShowPassport(state.candidate.lat, state.candidate.lon, state.activeListId);
  }

  // Баллы списка считаются на условиях момента добавления (спрос/сеть) -
  // при смене условий список теряет сопоставимость, поэтому очищаем.
  if (state.candidateList.length > 0) {
    state.candidateList = [];
    state.activeListId = null;
    renderCandidateListTable();
  }
}

async function placeCandidateAndShowPassport(lat, lon, listId = null) {
  state.activeListId = listId;
  renderCandidateListTable(); // подсветить активную строку, если открыли из списка

  const candidateBase = { id: 'CANDIDATE', lat, lon, operator: 'РСЗС', status: 'candidate' };
  const candidate = { ...candidateBase, P_kW: 60, posts: 1, P_post_kW: 60, year_open: readControls().year };
  state.candidate = candidate;
  renderCandidate({ candidateSource: state.layers.candidateSource, candidate });
  document.getElementById('add-to-list-btn').disabled = false;

  const { dayType, season, year, scenario } = readControls();

  const loader = showLoader('Считаю спрос, очередь и соседей…', 0.03);
  await nextFrame();
  if (state.candidate !== candidate) return;

  // Быстрый черновик (М1-М4): готов почти мгновенно.
  const local = localEquilibrium({
    cells: state.cells,
    stations: state.stations,
    candidate,
    params: state.preciseParams,
    year,
    scenario,
    dayType,
    season,
    fullContext: state.fullContext,
    fullResult: state.fullResult,
  });
  state.localResult = local;

  document.getElementById('passport-placeholder').hidden = true;
  document.querySelector('#passport-placeholder .notice')?.remove();
  const passportEl = document.getElementById('passport');
  passportEl.hidden = false;
  const { hour } = readControls();
  const nearestCell = state.cells.reduce((best, c) => ((c.lat - lat) ** 2 + ((c.lon - lon) * 0.56) ** 2 < (best.lat - lat) ** 2 + ((best.lon - lon) * 0.56) ** 2 ? c : best));
  const scenarioLabel = { base: 'базовый рост', conservative: 'медленный рост', optimistic: 'быстрый рост' }[scenario];
  const conditions = `${dayType === 'weekend' ? 'Выходные' : 'Будни'} · ${season === 'winter' ? 'зима' : 'лето'} · ${year} · ${scenarioLabel}`;
  const { neighbors } = renderPassport({ container: passportEl, local, baselineS: state.baselineS, candidate, stations: state.stations, district: nearestCell.district, hour, conditions });

  renderNeighbors({
    neighborsSource: state.layers.neighborsSource,
    stations: state.stations,
    neighborDeltas: neighbors.map((n) => ({ globalIdx: n.globalJ, deltaS: n.deltaS })),
  });

  // Медленная часть (М5-М7, до 8 конфигураций x 8 равновесий) - отдельным
  // проходом, чтобы не задерживать быстрый паспорт. Актуально только для
  // сценария base (опорные равновесия по другим сценариям не кэшируем, 12.3).
  if (scenario !== 'base') {
    document.getElementById('passport-verdict-section').innerHTML = '<h3>Оборудование и рост до 2030</h3><p class="tbd">Перебор оборудования пока считается только для базового сценария.</p>';
    document.getElementById('passport-connection-section').innerHTML = '<h3>Подключение к сети</h3><p class="tbd">—</p>';
    loader.done();
    return;
  }

  loader.set(0.08, 'Подбираю оборудование…');
  await nextFrame();
  const t0 = performance.now();
  let evalResult;
  try {
    evalResult = await evaluateCandidateAsync({
      candidateBase,
      cells: state.cells,
      centers: state.centers,
      params: state.preciseParams,
      getBaseline,
      dist04Meters: state.tp04 ? dist04FromKnownTp(lat, lon, state.tp04) : null,
      onProgress: (done, total) => {
        // Новый клик по карте - старый расчёт больше не нужен.
        if (state.candidate !== candidate) throw new Error('cancelled');
        const nCfg = total / 8; // 8 режимов на вариант: 2 года × 2 сезона × 2 типа дня
        loader.set(0.08 + 0.92 * (done / total), `Подбираю оборудование: вариант ${Math.min(nCfg, Math.floor((done - 1) / 8) + 1)} из ${nCfg} · 2026 и 2030, зима и лето`);
      },
    });
  } catch (err) {
    if (err.message === 'cancelled') return;
    throw err;
  }
  console.log(`подбор оборудования: ${Math.round(performance.now() - t0)} мс`);
  if (state.candidate === candidate) {
    renderEquipment({ evalResult });
    loader.done();
  }
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// Полоса загрузки паспорта (в духе загрузочного экрана Clash of Clans):
// один экземпляр над паспортом, новый клик перезапускает её с нуля.
function showLoader(text, fraction) {
  const el = document.getElementById('passport-loader');
  const fill = el.querySelector('.loader-fill');
  const pct = el.querySelector('.loader-pct');
  const label = el.querySelector('.loader-text');
  el.hidden = false;
  el.classList.remove('loader-done');
  const set = (f, t) => {
    const v = Math.max(0, Math.min(1, f));
    fill.style.width = `${(v * 100).toFixed(1)}%`;
    pct.textContent = `${Math.round(v * 100)}%`;
    if (t) label.textContent = t;
  };
  set(fraction, text);
  return {
    set,
    done() {
      set(1, 'Готово');
      el.classList.add('loader-done');
      setTimeout(() => {
        if (el.classList.contains('loader-done')) el.hidden = true;
      }, 700);
    },
  };
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

function onMapClick(latlng) {
  // За МКАДом нет ни ячеек спроса, ни полных данных о станциях (модель
  // обрезана по МКАД, scripts/clip-to-mkad.js) - паспорт там показал бы
  // ложные "0 сессий".
  if (!insideMkad(latlng.lat, latlng.lng)) {
    document.getElementById('passport').hidden = true;
    const ph = document.getElementById('passport-placeholder');
    ph.hidden = false;
    ph.querySelector('.notice')?.remove();
    ph.insertAdjacentHTML('afterbegin', '<div class="notice">Эта точка за МКАДом. Там не собраны данные о станциях, поэтому модель её не считает — кликните внутри пунктирного кольца.</div>');
    state.candidate = null;
    document.getElementById('add-to-list-btn').disabled = true;
    return;
  }
  placeCandidateAndShowPassport(latlng.lat, latlng.lng, null);
}

// Список площадок с баллами (фидбек Росатома: "список с балльной оценкой:
// доступность мощности, трафик, конкуренция в радиусе, тип района"). Баллы
// считаются быстро (js/scoring.js), без перебора оборудования - чтобы можно
// было накидать много кандидатов подряд, не дожидаясь М5-М7 на каждый.
function scoreBadgeColor(score) {
  const t = Math.max(0, Math.min(1, score / 100));
  const r = Math.round(200 - t * 160);
  const g = Math.round(90 + t * 100);
  return `rgb(${r},${g},70)`;
}

function addCurrentCandidateToList() {
  if (!state.candidate) return;
  const raw = scoreCandidateRaw({
    candidate: state.candidate,
    cells: state.cells,
    stations: state.stations,
    centers: state.centers,
    params: state.preciseParams,
    demand: state.fullResult.demand,
  });
  state.candidateList.push({
    listId: state.candidateListNextId++,
    lat: state.candidate.lat,
    lon: state.candidate.lon,
    ...raw,
  });
  renderCandidateListTable();
}

function removeFromList(listId) {
  state.candidateList = state.candidateList.filter((c) => c.listId !== listId);
  if (state.activeListId === listId) state.activeListId = null;
  renderCandidateListTable();
}

function sortCandidateList(items) {
  const { key, dir } = state.candidateListSort;
  const sorted = [...items].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    return dir === 'asc' ? av - bv : bv - av;
  });
  return sorted;
}

function renderCandidateListTable() {
  const section = document.getElementById('candidate-list-section');
  const tbody = document.getElementById('candidate-list-body');
  if (state.candidateList.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const scored = normalizeAndScore(state.candidateList);
  const sorted = sortCandidateList(scored);

  tbody.innerHTML = sorted
    .map((c, i) => {
      const active = c.listId === state.activeListId ? ' class="active"' : '';
      return `<tr${active} data-list-id="${c.listId}">
        <td>${i + 1}</td>
        <td><span class="score-badge" style="background:${scoreBadgeColor(c.composite)}">${c.composite.toFixed(0)}</span></td>
        <td>${c.powerScore.toFixed(0)} <span class="hint">(${c.pAvailKW.toFixed(0)} кВт)</span></td>
        <td>${c.trafficScore.toFixed(0)}</td>
        <td>${c.competitionScore.toFixed(0)} <span class="hint">(${c.nearbyCount} рядом)</span></td>
        <td>${c.district}</td>
        <td><button class="remove-candidate-btn" data-remove-id="${c.listId}" title="Убрать из списка">✕</button></td>
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.remove-candidate-btn')) return;
      const id = Number(tr.dataset.listId);
      const entry = state.candidateList.find((c) => c.listId === id);
      if (entry) placeCandidateAndShowPassport(entry.lat, entry.lon, id);
    });
  });
  tbody.querySelectorAll('.remove-candidate-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromList(Number(btn.dataset.removeId));
    });
  });
}

function wireCandidateListSorting() {
  document.querySelectorAll('#candidate-list-table th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.candidateListSort.key === key) {
        state.candidateListSort.dir = state.candidateListSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.candidateListSort = { key, dir: 'desc' };
      }
      renderCandidateListTable();
    });
  });
}

// Кнопка «Проверить модель» (раздел 13). Т6/Т8 в браузере считаются в
// сокращённом виде (меньше кандидатов) - полные версии см. `npm test`.
async function runTests() {
  const btn = document.getElementById('run-tests-btn');
  const panel = document.getElementById('test-results');
  btn.disabled = true;
  panel.hidden = false;
  panel.innerHTML = '<p>Считаю тесты Т1–Т10 (около минуты)…</p>';
  await new Promise((r) => setTimeout(r, 0));

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
    const results = await runAllTests({
      cells: state.cells,
      stationsAll: state.stationsAll,
      stations: state.stations,
      params: state.preciseParams,
      fullContext: state.fullContext,
      fullResult: state.fullResult,
      onProgress: (r) => {
        rows.push(r);
        renderRows();
      },
    });
    const run = results.filter((r) => !r.pending);
    const hardFails = run.filter((r) => !r.pass && !r.soft);
    const softFails = run.filter((r) => !r.pass && r.soft);
    const pending = results.filter((r) => r.pending);
    const summary =
      (hardFails.length === 0 ? `Пройдены все проверки (${run.length - softFails.length} из ${run.length - softFails.length}${softFails.length ? `, ещё ${softFails.length} — ожидаемо мягкий результат` : ''})` : `${hardFails.length} тест(ов) провалено: ${hardFails.map((r) => r.id).join(', ')}`) +
      (pending.length ? `. Ждут данных от заказчика: ${pending.map((r) => r.id.replace('T', 'Т')).join(', ')}` : '');
    panel.innerHTML += `<div class="test-summary" style="color:${hardFails.length ? '#c0392b' : '#2e7d32'}">${summary}</div>`;
  } catch (err) {
    console.error(err);
    panel.innerHTML += `<div class="test-summary" style="color:#c0392b">Ошибка при прогоне тестов: ${err.message}</div>`;
  } finally {
    btn.disabled = false;
  }
}

async function main() {
  const { cells, stationsAll, centers, params, raw } = await loadData();
  const preciseParams = { ...params, equilibrium: { ...params.equilibrium, convergence_threshold_hours: params.equilibrium.convergence_threshold_hours_precise } };
  Object.assign(state, { cells, stationsAll, centers, params, preciseParams });


  state.layers = initMap();
  renderCentersLayer({ centersSource: state.layers.centersSource, centers: state.centers });
  state.layers.map.on('singleclick', (evt) => {
    document.getElementById('map-hint').classList.add('gone');
    // Клик по кластеру станций (несколько под курсором на текущем зуме) -
    // приближаем карту к его границам вместо постановки кандидата.
    const extent = clusterExtentAtPixel(state.layers.map, state.layers.stationsLayer, evt.pixel);
    if (extent) {
      state.layers.map.getView().fit(extent, { padding: [60, 60, 60, 60], maxZoom: 16, duration: 300 });
      return;
    }
    const pick = portfolioPickAtPixel(state.layers.map, evt.pixel);
    if (pick) {
      placeCandidateAndShowPassport(pick.lat, pick.lon);
      return;
    }
    onMapClick(coordToLatLng(evt.coordinate));
  });

  await recomputeFullEquilibrium();

  document.getElementById('loading').hidden = true;
  document.getElementById('layout').hidden = false;
  state.layers.map.updateSize();

  document.getElementById('hour-slider').addEventListener('input', rerenderMapForHour);
  document.getElementById('year-slider').addEventListener('input', () => {
    document.getElementById('year-label').textContent = document.getElementById('year-slider').value;
  });
  // Сегменты (Будни/Выходные, Лето/Зима, рост ЭМ) управляют скрытыми
  // <select>, которые читает readControls(); смена условий сразу
  // пересчитывает сеть - отдельной кнопки больше нет.
  document.querySelectorAll('.segmented').forEach((seg) => {
    const select = document.getElementById(seg.dataset.target);
    seg.querySelectorAll('button').forEach((btn) =>
      btn.addEventListener('click', () => {
        if (select.value === btn.dataset.value) return;
        seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
        select.value = btn.dataset.value;
        select.dispatchEvent(new Event('change'));
      })
    );
  });
  let recomputeTimer = null;
  const scheduleRecompute = () => {
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(recomputeFullEquilibrium, 120);
  };
  ['day-type-select', 'season-select', 'scenario-select'].forEach((id) => document.getElementById(id).addEventListener('change', scheduleRecompute));
  document.getElementById('year-slider').addEventListener('change', scheduleRecompute);
  document.getElementById('run-tests-btn').addEventListener('click', runTests);
  document.getElementById('add-to-list-btn').addEventListener('click', addCurrentCandidateToList);
  wireCandidateListSorting();
  loadPortfolio();
  document.getElementById('toggle-slow').addEventListener('change', async (e) => {
    if (e.target.checked && state.layers.slowSource.getFeatures().length === 0) {
      const d = await fetch('data/stations-slow.json').then((r) => r.json());
      renderSlowStations({ slowSource: state.layers.slowSource, stations: d.stations });
      document.getElementById('slow-count').textContent = ` (${d.stations.length})`;
    }
    state.layers.slowLayer.setVisible(e.target.checked);
    document.getElementById('legend-slow').hidden = !e.target.checked;
  });
  fetch('data/mkad.json')
    .then((r) => r.json())
    .then((d) => {
      state.mkadRing = d.ring;
      renderMkad({ mkadSource: state.layers.mkadSource, ring: d.ring });
    })
    .catch(() => {});
  fetch('data/tp04.json')
    .then((r) => r.json())
    .then((d) => (state.tp04 = d.points))
    .catch(() => {});

  // Фоновый прогрев остальных 7 опорных равновесий убран: на 779 реальных
  // станциях один расчёт равновесия занимает секунды, а не миллисекунды, и
  // цепочка setTimeout(...,50) держит поток занятым почти непрерывно первые
  // ~20-25с после отрисовки карты - за это время debounce-таймер singleclick
  // в OpenLayers (250мс) физически не получает свободного тика, и первый
  // клик по карте у пользователя "теряется" (на самом деле не теряется, а
  // откладывается на десятки секунд). getBaseline() ниже и так кэширует
  // результат по ключу год|сезон|деньТипа - смена сценария просто считает
  // равновесие один раз при первом обращении, без фонового прогрева.
}

// --- Модуль 8: рекомендации, где ставить (data/portfolio.json) ---
const fmtPct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function loadPortfolio() {
  try {
    const res = await fetch(`data/portfolio.json?v=${Date.now()}`);
    if (!res.ok) return;
    state.portfolio = await res.json();
  } catch {
    return;
  }
  document.getElementById('portfolio-section').hidden = false;
  const redraw = () =>
    renderPortfolio({
      portfolioSource: state.layers.portfolioSource,
      portfolio: state.portfolio,
      showModel: document.getElementById('toggle-model').checked,
      showTraditional: document.getElementById('toggle-trad').checked,
    });
  document.getElementById('toggle-model').addEventListener('change', redraw);
  document.getElementById('toggle-trad').addEventListener('change', redraw);
  redraw();
  renderPortfolioPanel();
  renderHeroKpis();
}

// Три главные цифры результата в шапке - из data/portfolio.json, чтобы после
// пересчёта рекомендаций они обновлялись сами.
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
    <div class="kpi"><div class="kpi-value">+${Math.round(ex('model'))}</div><div class="kpi-label">новых клиентов в сутки дают ${mPicks.length} станций модели<br><span>при традиционном выборе мест — ${ex('traditional') >= 0 ? '+' : '−'}${Math.abs(Math.round(ex('traditional')))}</span></div></div>
    <div class="kpi"><div class="kpi-value">${ratio ? `×${ratio.toFixed(1)}` : '—'}</div><div class="kpi-label">больше новых клиентов на каждый вложенный рубль<br><span>${(capex(mPicks) / 1e6).toFixed(0)} млн ₽ вместо ${(capex(tPicks) / 1e6).toFixed(0)} млн ₽</span></div></div>
    <div class="kpi"><div class="kpi-value">${clsA}/${mPicks.length}</div><div class="kpi-label">мест с дешёвым подключением к сетям Россетей<br><span>подстанция 0.4 кВ ближе 200 м</span></div></div>
    <a class="kpi-cta" href="#portfolio-section">Смотреть рекомендованные места ↓</a>`;
  el.hidden = false;
}

function renderPortfolioPanel() {
  const pf = state.portfolio;
  const modelPicks = pf.model?.picks || [];
  const running = pf.status !== 'done';
  document.getElementById('portfolio-subtitle').textContent =
    'Модель выбрала 10 мест внутри МКАД и сравнила их с тем, как места выбирают сейчас.' + (running ? ' Расчёт ещё идёт — обновите страницу позже.' : '');

  const my = pf.metrics_by_year;
  const compare = document.getElementById('portfolio-compare');
  if (my) {
    const fmtNum = (v, d = 1) => (v === null || v === undefined || !isFinite(v) ? '—' : v.toFixed(d));
    const sign = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(0)}`;
    const years = [2026, 2028, 2030].filter((y) => my[y]);
    const ex = (y, k) => my[y][k].sessions_per_day_network - my[y].baseline.sessions_per_day_network;
    const m = my[2028] || my[years[0]];
    const b = m.baseline;
    const capex = (picks) => picks.reduce((a, p) => a + (p.capex_rub || 0), 0);
    const perMln = (picks) => picks.reduce((a, p) => a + ((p.new_demand_2026 || 0) + (p.new_demand_2030 || 0)) / 2, 0) / Math.max(1e-9, capex(picks) / 1e6);
    const fmtPp = (x, base) => `${fmtPct(x)} <span class="delta">(${x - base >= 0 ? '+' : '−'}${Math.abs((x - base) * 100).toFixed(2)} п.п.)</span>`;
    // [название, традиционный, модель, модель лучше?] либо ['group', заголовок]
    const rows = [
      ['group', 'Новые клиенты сети: дополнительно обслужено, сессий в сутки'],
      ...years.map((y) => [`${y} год — без новых станций сеть обслуживает ${fmtPct(my[y].baseline.served_share_of_demand)} спроса${y === 2028 ? ' (плановые станции города почти закрывают дефицит)' : ''}`, sign(ex(y, 'traditional')), sign(ex(y, 'model')), ex(y, 'model') > ex(y, 'traditional')]),
      ['group', 'Загрузка новых станций (2028)'],
      ['Средняя загрузка постов', fmtPct(m.traditional.U_new_mean), fmtPct(m.model.U_new_mean), m.model.U_new_mean > m.traditional.U_new_mean],
      ['Станций с загрузкой ниже 20%', fmtPct(m.traditional.share_new_U_below_20), fmtPct(m.model.share_new_U_below_20), m.model.share_new_U_below_20 < m.traditional.share_new_U_below_20],
      ['group', 'Доступность для водителей (2028)'],
      ['Доля спроса, обслуженная сетью', fmtPp(m.traditional.served_share_of_demand, b.served_share_of_demand), fmtPp(m.model.served_share_of_demand, b.served_share_of_demand), m.model.served_share_of_demand > m.traditional.served_share_of_demand],
      ['Отказы из-за очереди (все посты заняты)', fmtPct(m.traditional.queue_loss_share), fmtPct(m.model.queue_loss_share), m.model.queue_loss_share < m.traditional.queue_loss_share - 0.0005],
      ['Среднее ожидание в пиковый час, мин', fmtNum(m.traditional.wait_min_peak), fmtNum(m.model.wait_min_peak), m.model.wait_min_peak < m.traditional.wait_min_peak - 0.05],
      ['group', 'Вложения и подключение к сети'],
      ['Вложения: оборудование + подключение + площадка', `${fmtNum(capex(pf.traditional.picks) / 1e6)} млн ₽`, `${fmtNum(capex(modelPicks) / 1e6)} млн ₽`, capex(modelPicks) < capex(pf.traditional.picks)],
      ['Новых клиентов сети в сутки на 1 млн ₽ (среднее 2026 и 2030)', fmtNum(perMln(pf.traditional.picks), 2), fmtNum(perMln(modelPicks), 2), perMln(modelPicks) > perMln(pf.traditional.picks)],
      ['Площадок с льготным подключением (класс А)', `${pf.traditional.picks.filter((p) => p.cls === 'А').length} из ${pf.traditional.picks.length}`, `${modelPicks.filter((p) => p.cls === 'А').length} из ${modelPicks.length}`, modelPicks.filter((p) => p.cls === 'А').length / Math.max(1, modelPicks.length) > pf.traditional.picks.filter((p) => p.cls === 'А').length / Math.max(1, pf.traditional.picks.length)],
    ];
    compare.innerHTML = `<table class="compare-table">
      <thead><tr><th>Базовый сценарий, средний день года · ${escapeHtml(pf.equipment || 'DC150-2')} у обеих стратегий</th><th class="col-trad"><span class="pin pin-trad">■</span> Традиционный подход</th><th class="col-model"><span class="pin pin-model">★</span> По модели</th></tr></thead>
      <tbody>${rows
        .map((r) =>
          r[0] === 'group'
            ? `<tr class="group"><td colspan="3">${r[1]}</td></tr>`
            : `<tr><td>${r[0]}</td><td class="num col-trad">${r[1]}</td><td class="num col-model ${r[3] && modelPicks.length > 0 ? 'better' : ''}">${r[2]}</td></tr>`
        )
        .join('')}</tbody></table>`;
  } else {
    compare.innerHTML = '';
  }

  document.getElementById('portfolio-body').innerHTML = modelPicks
    .map(
      (p, k) => `<tr data-k="${k}">
        <td><span class="pin pin-model">${k + 1}</span></td>
        <td><div class="site-kind">${escapeHtml(p.kind)}</div>${p.name ? `<div class="site-name">${escapeHtml(p.name)}</div>` : ''}</td>
        <td>${escapeHtml(p.district || '—')}</td>
        <td class="num"><strong>+${(p.new_demand_2026 ?? 0).toFixed(1)} → +${(p.new_demand_2030 ?? 0).toFixed(1)}</strong></td>
        <td class="num">${(p.sessions_2026 ?? 0).toFixed(1)} → ${(p.sessions_2030 ?? 0).toFixed(1)}<div class="npv-range">рост ×${((p.sessions_2030 ?? 0) / Math.max(0.01, p.sessions_2026 ?? 0)).toFixed(2)}</div></td>
        <td>${escapeHtml(p.omega)} · класс ${escapeHtml(p.cls || '—')}<div class="npv-range">${p.conn_cost_high_rub ? `подключение ${(p.conn_cost_low_rub / 1e6).toFixed(1)}–${(p.conn_cost_high_rub / 1e6).toFixed(1)} млн ₽` : ''}${p.dist04_m ? `, ТП в ${p.dist04_m} м` : ''}</div></td>
      </tr>`
    )
    .join('');
  document.querySelectorAll('#portfolio-body tr').forEach((tr) =>
    tr.addEventListener('click', () => {
      const p = modelPicks[Number(tr.dataset.k)];
      state.layers.map.getView().animate({ center: ol.proj.fromLonLat([p.lon, p.lat]), zoom: 14, duration: 500 });
      document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
      placeCandidateAndShowPassport(p.lat, p.lon);
    })
  );

  const trad = pf.traditional;
  document.getElementById('portfolio-footnote').textContent =
    (pf.model?.stoppedReason ? `Модель остановилась раньше ${pf.N} станций: ${pf.model.stoppedReason}. ` : '') +
    (pf.traditional?.dropped?.length ? `Традиционный подход потерял ${pf.traditional.dropped.length} площадк(и): класс подключения В выяснился поздно. ` : '') +
    'Места выбраны по новым для сети клиентам на 1 млн ₽ вложений: новые клиенты — сессии, которых без станции сеть не обслужила бы (уезжали без зарядки или уходили из-за очереди), без переманенных у соседей, среднее за 2026 и 2030; вложения — оборудование + подключение + площадка, без тарифов. Оборудование одинаковое у обеих стратегий (DC150-2), поэтому разница — в месте и цене подключения; в прогнозе отдельной точки модель ещё и подбирает для неё лучший вариант оборудования — он может отличаться. Класс подключения: класс А (ТП 0.4 кВ Россетей ближе 200 м, ~5–10 тыс. ₽/кВт) против Б (~50–80 тыс. ₽/кВт); «А|Б» — ТП в данных нет, считаем по Б. Клик по строке — полный паспорт площадки.';
}

main().catch((err) => {
  console.error(err);
  document.getElementById('loading').textContent = 'Ошибка загрузки: ' + err.message;
});
