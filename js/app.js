// Точка входа статического сайта. Оркестрирует загрузку данных, карту,
// ползунок времени и черновик паспорта площадки (клик по карте).
import { SEGMENTS } from './demand.js';
import { buildNetworkContext, equilibrium, localEquilibrium, dailySessions } from './equilibrium.js';
import { evaluateCandidate } from './equipment.js';
import { initMap, renderDemandLayer, renderStationsLayer, renderCentersLayer, renderCandidate, renderNeighbors } from './mapview.js';
import { renderPassport, renderEquipmentEconomics } from './passport.js';
import { runAllTests } from './tests.js';

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

async function renderFooter(raw) {
  const footer = document.getElementById('data-footer');
  const lines = DATA_FILES.map((name) => `<div>${name}.json — ${raw[name === 'params' ? 'params' : name + 'Raw'].source} (${raw[name === 'params' ? 'params' : name + 'Raw'].date})</div>`);
  lines.push('<div>Версия модели: v1 (прототип, М1-М7 + локальный пересчёт) · Спецификация: docs/spec.txt</div>');
  footer.innerHTML = lines.join('\n');
}

function setStatus(msg) {
  document.getElementById('recompute-status').textContent = msg;
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

function rerenderMapForHour() {
  const { hour } = readControls();
  document.getElementById('hour-label').textContent = `${String(hour).padStart(2, '0')}:00`;

  const { fullResult, cells, stations } = state;
  const Uarr = new Float64Array(stations.length);
  for (let j = 0; j < stations.length; j++) Uarr[j] = fullResult.qh.U[j * 24 + hour];

  renderStationsLayer({
    stationsLayer: state.layers.stationsLayer,
    stations,
    activeStations: fullResult.activeStations,
    Uarr,
    onClickStation: null,
  });
  renderDemandLayer({
    demandHeatmap: state.layers.demandHeatmap,
    cells,
    totalDemandPerCell: totalDemandPerCellAtHour(fullResult.demand, cells.length, hour),
  });
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
  setStatus('считаю…');
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
  setStatus(`готово за ${ms} мс, ${state.fullResult.it} итераций${state.fullResult.converged ? '' : ' (не сошлось!)'}`);

  rerenderMapForHour();

  if (state.candidate) {
    document.getElementById('passport').hidden = true;
    document.getElementById('passport-placeholder').hidden = false;
    document.getElementById('passport-placeholder').textContent = 'Условия сети изменились — кликните по карте ещё раз.';
    state.candidate = null;
  }
}

async function onMapClick(latlng) {
  const candidateBase = { id: 'CANDIDATE', lat: latlng.lat, lon: latlng.lng, operator: 'РСЗС', status: 'candidate' };
  const candidate = { ...candidateBase, P_kW: 60, posts: 1, P_post_kW: 60, year_open: readControls().year };
  state.candidate = candidate;
  renderCandidate({ candidateLayer: state.layers.candidateLayer, candidate });

  const { dayType, season, year, scenario } = readControls();

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
  const passportEl = document.getElementById('passport');
  passportEl.hidden = false;
  const { neighbors } = renderPassport({ container: passportEl, local, baselineS: state.baselineS, candidate, stations: state.stations });

  renderNeighbors({
    neighborsLayer: state.layers.neighborsLayer,
    stations: state.stations,
    neighborDeltas: neighbors.map((n) => ({ globalIdx: n.globalJ, deltaS: n.deltaS })),
  });

  // Медленная часть (М5-М7, до 8 конфигураций x 8 равновесий) - отдельным
  // проходом, чтобы не задерживать быстрый паспорт. Актуально только для
  // сценария base (опорные равновесия по другим сценариям не кэшируем, 12.3).
  if (scenario !== 'base') {
    document.getElementById('passport-verdict-section').innerHTML = '<h3>Вердикт и конфигурация</h3><p class="tbd">Перебор оборудования пока считается только для базового сценария.</p>';
    document.getElementById('passport-connection-section').innerHTML = '<h3>Подключение к сети</h3><p class="tbd">—</p>';
    document.getElementById('passport-economics-section').innerHTML = '<h3>Экономика</h3><p class="tbd">—</p>';
    return;
  }

  await new Promise((r) => setTimeout(r, 0));
  const t0 = performance.now();
  const evalResult = evaluateCandidate({
    candidateBase,
    cells: state.cells,
    centers: state.centers,
    params: state.preciseParams,
    getBaseline,
  });
  console.log(`подбор оборудования: ${Math.round(performance.now() - t0)} мс`);
  if (state.candidate === candidate) {
    renderEquipmentEconomics({ evalResult });
  }
}

// Кнопка «Проверить модель» (раздел 13). Т6/Т8 в браузере считаются в
// сокращённом виде (меньше кандидатов) - полные версии см. `npm test`.
async function runTests() {
  const btn = document.getElementById('run-tests-btn');
  const panel = document.getElementById('test-results');
  btn.disabled = true;
  panel.hidden = false;
  panel.innerHTML = '<p>Считаю Т1-Т8…</p>';
  await new Promise((r) => setTimeout(r, 0));

  const rows = [];
  const renderRows = () => {
    panel.innerHTML = rows
      .map((r) => {
        const cls = r.pass ? 'pass' : r.soft ? 'soft-fail' : 'fail';
        const mark = r.pass ? '✓' : r.soft ? '⚠' : '✗';
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
    const hardFails = results.filter((r) => !r.pass && !r.soft);
    const softFails = results.filter((r) => !r.pass && r.soft);
    const summary = hardFails.length === 0 ? `Все обязательные тесты пройдены (${results.length - softFails.length}/${results.length - softFails.length}${softFails.length ? `, +${softFails.length} ожидаемо мягких` : ''})` : `${hardFails.length} тест(ов) провалено: ${hardFails.map((r) => r.id).join(', ')}`;
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

  renderFooter({ cellsRaw: raw.cellsRaw, stationsRaw: raw.stationsRaw, centersRaw: raw.centersRaw, params: raw.params });

  state.layers = await initMap();
  renderCentersLayer({ centersLayer: state.layers.centersLayer, centers: state.centers });
  state.layers.map.events.add('click', (e) => {
    const coords = e.get('coords'); // [lat, lon]
    onMapClick({ lat: coords[0], lng: coords[1] });
  });

  await recomputeFullEquilibrium();

  document.getElementById('loading').hidden = true;
  document.getElementById('layout').hidden = false;
  state.layers.map.container.fitToViewport();

  document.getElementById('hour-slider').addEventListener('input', rerenderMapForHour);
  document.getElementById('year-slider').addEventListener('input', () => {
    document.getElementById('year-label').textContent = document.getElementById('year-slider').value;
  });
  document.getElementById('recompute-btn').addEventListener('click', recomputeFullEquilibrium);
  document.getElementById('run-tests-btn').addEventListener('click', runTests);

  // Фоновый прогрев оставшихся 7 опорных равновесий (не блокирует UI), чтобы
  // клик по карте позже не ждал их с нуля. Черновик Web Worker - на потом.
  const combos = [];
  for (const year of [2026, 2030]) for (const season of ['winter', 'summer']) for (const dayType of ['weekday', 'weekend']) combos.push({ year, season, dayType });
  (function warmNext(i) {
    if (i >= combos.length) return;
    setTimeout(() => {
      getBaseline(combos[i].year, combos[i].season, combos[i].dayType);
      warmNext(i + 1);
    }, 50);
  })(0);
}

main().catch((err) => {
  console.error(err);
  document.getElementById('loading').textContent = 'Ошибка загрузки: ' + err.message;
});
