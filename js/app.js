// Точка входа статического сайта. Оркестрирует загрузку данных, карту,
// ползунок времени и черновик паспорта площадки (клик по карте).
import { SEGMENTS } from './demand.js';
import { buildNetworkContext, equilibrium, localEquilibrium, dailySessions } from './equilibrium.js';
import { evaluateCandidate } from './equipment.js';
import { initMap, renderDemandLayer, renderStationsLayer, renderCentersLayer, renderCandidate, renderNeighbors, coordToLatLng, clusterExtentAtPixel, renderPortfolio, portfolioPickAtPixel, renderMkad } from './mapview.js';
import { renderPassport, renderEquipmentEconomics } from './passport.js';
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
  renderDemandLayer({
    demandSource: state.layers.demandSource,
    cells,
    totalDemandPerCell: totalDemandPerCellAtHour(fullResult.demand, cells.length, hour),
    scaleDemandPerCell: totalDemandPerCellAtHour(fullResult.demand, cells.length, peakDemandHour(fullResult.demand, cells.length)),
  });
  const dayLabel = readControls().dayType === 'weekend' ? 'выходной' : 'будни';
  document.getElementById('map-legend-time').textContent = `${String(hour).padStart(2, '0')}:00 · ${dayLabel}`;
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
    document.getElementById('add-to-list-btn').disabled = true;
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
    neighborsSource: state.layers.neighborsSource,
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
    dist04Meters: state.tp04 ? dist04FromKnownTp(lat, lon, state.tp04) : null,
  });
  console.log(`подбор оборудования: ${Math.round(performance.now() - t0)} мс`);
  if (state.candidate === candidate) {
    renderEquipmentEconomics({ evalResult });
  }
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
    ph.textContent = 'Точка за МКАДом — вне модели: за кольцом не собраны данные о станциях, поэтому спрос и сеть там не считаются. Кликните внутри МКАД.';
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


  state.layers = initMap();
  renderCentersLayer({ centersSource: state.layers.centersSource, centers: state.centers });
  state.layers.map.on('singleclick', (evt) => {
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
  document.getElementById('recompute-btn').addEventListener('click', recomputeFullEquilibrium);
  document.getElementById('run-tests-btn').addEventListener('click', runTests);
  document.getElementById('add-to-list-btn').addEventListener('click', addCurrentCandidateToList);
  wireCandidateListSorting();
  loadPortfolio();
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
const fmtMlnRub = (rub) => (rub === null || rub === undefined ? '—' : `${rub < 0 ? '−' : ''}${Math.abs(rub / 1e6).toFixed(1)} млн ₽`);
const fmtPct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
const fmtYears = (y) => (y === null || y === undefined || !isFinite(y) ? 'больше 10 лет' : `${y.toFixed(1)} года`);
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
}

function renderPortfolioPanel() {
  const pf = state.portfolio;
  const modelPicks = pf.model?.picks || [];
  const running = pf.status !== 'done';
  document.getElementById('portfolio-subtitle').textContent =
    `${modelPicks.length} площадок внутри МКАД, выбранных моделью из ${pf.N ? `пула 300 реальных мест (парковки, ТЦ, АЗС, бизнес-центры, гостиницы)` : 'пула'}: по шагу за раз, с пересчётом всей сети после каждой — следующая точка учитывает уже поставленные.` +
    (running ? ' Расчёт ещё идёт — обновите страницу позже.' : '');

  const m = pf.metrics;
  const compare = document.getElementById('portfolio-compare');
  if (m) {
    const b = m.baseline;
    const extra = (x) => x.sessions_per_day_network - b.sessions_per_day_network;
    const perMln = (x) => (x.CAPEX_total_rub > 0 ? extra(x) / (x.CAPEX_total_rub / 1e6) : null);
    const fmtNum = (v, d = 1) => (v === null || v === undefined || !isFinite(v) ? '—' : v.toFixed(d));
    const fmtPp = (x, y) => `${fmtPct(x)} <span class="delta">(${y >= 0 ? '+' : '−'}${Math.abs(y * 100).toFixed(2)} п.п.)</span>`;
    // [название, традиционный, модель, модель лучше?, группа]
    const rows = [
      ['group', 'Загрузка сети: дополнительно обслужено, сессий/сутки'],
      ...[2026, 2028, 2030].filter((y) => pf.metrics_by_year?.[y]).map((y) => {
        const my = pf.metrics_by_year[y];
        const ex = (k) => my[k].sessions_per_day_network - my.baseline.sessions_per_day_network;
        const sign = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(0)}`;
        return [`${y} год — без новых станций сеть обслуживает ${fmtPct(my.baseline.served_share_of_demand)} спроса${y === 2028 ? ' (плановые станции города почти закрывают дефицит)' : ''}`, sign(ex('traditional')), sign(ex('model')), ex('model') >= ex('traditional')];
      }),
      ['Средняя загрузка новых станций', fmtPct(m.traditional.U_new_mean), fmtPct(m.model.U_new_mean), m.model.U_new_mean >= m.traditional.U_new_mean],
      ['Новых станций с загрузкой < 20%', fmtPct(m.traditional.share_new_U_below_20), fmtPct(m.model.share_new_U_below_20), m.model.share_new_U_below_20 <= m.traditional.share_new_U_below_20],
      ['group', 'Издержки'],
      ['Вложения (у традиционного — с потерянными)', fmtMlnRub(m.traditional.CAPEX_total_rub), fmtMlnRub(m.model.CAPEX_total_rub), m.model.CAPEX_total_rub <= m.traditional.CAPEX_total_rub],
      ['Доп. сессий/сутки в 2028 на 1 млн ₽ вложений', fmtNum(perMln(m.traditional), 2), fmtNum(perMln(m.model), 2), (perMln(m.model) ?? 0) >= (perMln(m.traditional) ?? 0)],
      ['group', 'Доступность для водителей'],
      ['Доля спроса, обслуженная сетью', fmtPp(m.traditional.served_share_of_demand, m.traditional.served_share_of_demand - b.served_share_of_demand), fmtPp(m.model.served_share_of_demand, m.model.served_share_of_demand - b.served_share_of_demand), m.model.served_share_of_demand >= m.traditional.served_share_of_demand],
      ['Отказы из-за очереди (все посты заняты)', fmtPct(m.traditional.queue_loss_share), fmtPct(m.model.queue_loss_share), m.model.queue_loss_share <= m.traditional.queue_loss_share],
      ['Среднее ожидание в пиковый час, мин', fmtNum(m.traditional.wait_min_peak), fmtNum(m.model.wait_min_peak), m.model.wait_min_peak <= m.traditional.wait_min_peak],
      ['group', 'Экономика (дополнительно)'],
      [`NPV за 10 лет при электроэнергии ${pf.model?.picks?.[0]?.p_el_min ?? 8}–${pf.model?.picks?.[0]?.p_el_max ?? 13} ₽/кВт·ч`, `${fmtMlnRub(m.traditional.NPV_pel_max_total_rub)} … ${fmtMlnRub(m.traditional.NPV_pel_min_total_rub)}`, `${fmtMlnRub(m.model.NPV_pel_max_total_rub)} … ${fmtMlnRub(m.model.NPV_pel_min_total_rub)}`, m.model.NPV_pel_min_total_rub >= m.traditional.NPV_pel_min_total_rub],
    ];
    compare.innerHTML = `<table class="compare-table">
      <thead><tr><th>${pf.metrics_by_year ? 'Базовый сценарий, средний день года' : '2028 год'}</th><th class="col-trad"><span class="pin pin-trad">■</span> Традиционный подход</th><th class="col-model"><span class="pin pin-model">★</span> По модели</th></tr></thead>
      <tbody>${rows
        .map((r) =>
          r[0] === 'group'
            ? `<tr class="group"><td colspan="3">${r[1]}</td></tr>`
            : `<tr><td>${r[0]}</td><td class="num col-trad">${r[1]}</td><td class="num col-model ${r[3] && m.model.n > 0 ? 'better' : ''}">${r[2]}</td></tr>`
        )
        .join('')}</tbody></table>`;
  } else {
    compare.innerHTML = '';
  }

  const econBadge = (p) => {
    const v = p.econ_verdict || '';
    const cls = v.startsWith('окупается при любой') ? 'verdict-go' : v.startsWith('не окупается') ? 'verdict-no' : 'verdict-cond';
    return `<span class="verdict ${cls}">${escapeHtml(v || '—')}</span>`;
  };
  document.getElementById('portfolio-body').innerHTML = modelPicks
    .map(
      (p, k) => `<tr data-k="${k}">
        <td><span class="pin pin-model">${k + 1}</span></td>
        <td><div class="site-kind">${escapeHtml(p.kind)}</div>${p.name ? `<div class="site-name">${escapeHtml(p.name)}</div>` : ''}</td>
        <td>${escapeHtml(p.district || '—')}</td>
        <td><strong>${escapeHtml(p.omega)}</strong><div class="npv-range">класс ${escapeHtml(p.cls || '—')}${p.dist04_m ? `, ТП в ${p.dist04_m} м` : ''}</div></td>
        <td class="num"><strong>+${(p.new_demand_2026 ?? 0).toFixed(1)} → +${(p.new_demand_2030 ?? 0).toFixed(1)}</strong><div class="npv-range">${(p.new_demand_per_mln ?? 0).toFixed(2)} в среднем на 1 млн ₽</div></td>
        <td class="num">${p.S_2026} → ${p.S_2030}</td>
        <td>${econBadge(p)}<div class="npv-range">NPV ${fmtMlnRub(p.NPV_pel_max_rub)} … ${fmtMlnRub(p.NPV_pel_min_rub)}</div></td>
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
    (pf.model?.stoppedReason ? `Модель остановилась раньше N=${pf.N}: ${pf.model.stoppedReason}. ` : '') +
    (trad?.dropped?.length ? `Традиционный подход потерял ${trad.dropped.length} площадк(и) на позднем выяснении класса подключения В (+${fmtMlnRub(trad.sunk_rub)} потерянных затрат). ` : '') +
    'Места выбраны по новому для сети спросу на рубль вложений: сколько сессий станция добавляет сети сверх переманенных у соседей (не по NPV — экономика дополнительно, её главный параметр, цена электроэнергии для РСЗС, неизвестен; показан диапазон). Класс А — известная ТП 0.4 кВ ближе 200 м (OSM); «А|Б» — ТП в данных нет, считаем консервативно как Б. ' +
    ((pf.model?.picks || []).some((p) => p.acc_2030_below_target) ? 'К 2030 станции в модели перегружены: парк ЭМ по плану города растёт ×14, а сеть с плановыми станциями «Энергии Москвы» — примерно ×3, поэтому доступность 90% в зимний будний день 2030 недостижима ни на одной площадке, и конфигурация выбрана по новому спросу на рубль. ' : '') +
    'Клик по строке — полный паспорт площадки.';
}

main().catch((err) => {
  console.error(err);
  document.getElementById('loading').textContent = 'Ошибка загрузки: ' + err.message;
});
