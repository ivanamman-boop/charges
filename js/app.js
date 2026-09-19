// Точка входа статического сайта. Оркестрирует загрузку данных, карту,
// ползунок времени и черновик паспорта площадки (клик по карте).
import { SEGMENTS } from './demand.js';
import { buildNetworkContext, equilibrium, localEquilibrium, dailySessions } from './equilibrium.js';
import { initMap, renderDemandLayer, renderStationsLayer, renderCentersLayer, renderCandidate, renderNeighbors } from './mapview.js';
import { renderPassport } from './passport.js';

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
  lines.push('<div>Версия модели: v1 (прототип, М1-М4 + локальный пересчёт) · Спецификация: docs/spec.txt</div>');
  footer.innerHTML = lines.join('\n');
}

function setStatus(msg) {
  document.getElementById('recompute-status').textContent = msg;
}

const state = {
  cells: null,
  stationsAll: null,
  centers: null,
  params: null,
  stations: null, // активные в текущем году
  fullContext: null,
  fullResult: null,
  baselineS: null,
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
    demandLayer: state.layers.demandLayer,
    cells,
    totalDemandPerCell: totalDemandPerCellAtHour(fullResult.demand, cells.length, hour),
  });
}

async function recomputeFullEquilibrium() {
  setStatus('считаю…');
  await new Promise((r) => setTimeout(r, 0)); // дать браузеру отрисовать статус

  const { dayType, season, year, scenario } = readControls();
  const t0 = performance.now();

  state.stations = state.stationsAll.filter((s) => s.year_open <= year);
  state.fullContext = buildNetworkContext({ cells: state.cells, stations: state.stations, params: state.params });
  state.fullResult = equilibrium({
    cells: state.cells,
    stations: state.stations,
    params: state.params,
    year,
    scenario,
    dayType,
    season,
    context: state.fullContext,
  });
  state.baselineS = dailySessions(state.fullResult.qh.lambdaSrv, state.stations.length);

  const ms = Math.round(performance.now() - t0);
  setStatus(`готово за ${ms} мс, ${state.fullResult.it} итераций${state.fullResult.converged ? '' : ' (не сошлось!)'}`);

  rerenderMapForHour();

  // Кандидат при смене условий сети теряет силу — просим пересчитать заново.
  if (state.candidate) {
    document.getElementById('passport').hidden = true;
    document.getElementById('passport-placeholder').hidden = false;
    document.getElementById('passport-placeholder').textContent = 'Условия сети изменились — кликните по карте ещё раз.';
    state.candidate = null;
  }
}

function onMapClick(latlng) {
  const candidate = {
    id: 'CANDIDATE',
    lat: latlng.lat,
    lon: latlng.lng,
    operator: 'РСЗС',
    P_kW: 60,
    posts: 1,
    P_post_kW: 60,
    status: 'candidate',
    year_open: readControls().year,
  };
  state.candidate = candidate;
  renderCandidate({ candidateLayer: state.layers.candidateLayer, candidate });

  const { dayType, season, year, scenario } = readControls();
  const precise = { ...state.params, equilibrium: { ...state.params.equilibrium, convergence_threshold_hours: state.params.equilibrium.convergence_threshold_hours_precise } };

  const local = localEquilibrium({
    cells: state.cells,
    stations: state.stations,
    candidate,
    params: precise,
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
}

async function main() {
  const { cells, stationsAll, centers, params, raw } = await loadData();
  Object.assign(state, { cells, stationsAll, centers, params });

  renderFooter({ cellsRaw: raw.cellsRaw, stationsRaw: raw.stationsRaw, centersRaw: raw.centersRaw, params: raw.params });

  state.layers = initMap();
  renderCentersLayer({ centersLayer: state.layers.centersLayer, centers: state.centers });
  state.layers.map.on('click', (e) => onMapClick(e.latlng));

  await recomputeFullEquilibrium();

  document.getElementById('loading').hidden = true;
  document.getElementById('layout').hidden = false;
  state.layers.map.invalidateSize();

  document.getElementById('hour-slider').addEventListener('input', rerenderMapForHour);
  document.getElementById('year-slider').addEventListener('input', () => {
    document.getElementById('year-label').textContent = document.getElementById('year-slider').value;
  });
  document.getElementById('recompute-btn').addEventListener('click', recomputeFullEquilibrium);
}

main().catch((err) => {
  console.error(err);
  document.getElementById('loading').textContent = 'Ошибка загрузки: ' + err.message;
});
