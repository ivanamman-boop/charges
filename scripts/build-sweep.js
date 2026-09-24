// Чеклист систематического объезда Яндекс.Карт -> tools/yandex-sweep.html.
//
// Почему: поиск "Электрозаправки" отдаёт не больше 25 станций на окно карты
// (results=25), остальные - только при прокрутке списка результатов. В
// объездах 23-24.09 в лимит упирались 75 из 156 и 28 из 81 окна (до 57
// станций в окне), список не прокручивался ни разу - в плотных районах
// часть станций до HAR не доходила. Здесь - сетка квадратов 4×4 км по всей
// Москве внутри МКАД; каждый открывается в одной и той же вкладке Яндекса
// (DevTools с Preserve log пишет весь объезд в один HAR), в каждом нужно
// прокрутить список слева до конца. Дальше: npm run import:yandex -- файл.har.
//
// Запуск: npm run build:sweep
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ring = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'mkad.json'), 'utf8')).ring;
const insideMkad = (lat, lon) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ai, bi] = ring[i];
    const [aj, bj] = ring[j];
    if (ai > lat !== aj > lat && lon < ((bj - bi) * (lat - ai)) / (aj - ai) + bi) inside = !inside;
  }
  return inside;
};

// Квадраты адаптивные (дерево): базовый 4×4 км делится на 4, пока в нём
// известно больше SPLIT_ABOVE станций (по всем прошлым объездам). Причина:
// прокрутка списка не подгружает станции сверх 25 (объезд 24.09 - ни одного
// запроса следующей страницы), поэтому в плотных районах окно должно быть
// мельче. Известных станций меньше, чем реальных, отсюда запас: 15 < 25.
const BASE_KM = 4;
const MIN_KM = 1;
const SPLIT_ABOVE = 15;
const ZOOM_BY_KM = { 4: 13.4, 2: 14.4, 1: 15.4 }; // окно ~1.2 размера квадрата
const known = JSON.parse(readFileSync(join(__dirname, 'data-sources', 'yandex-charging-stations-compact.json'), 'utf8')).items.map((x) => [x.coordinates[1], x.coordinates[0]]);
const lats = ring.map((p) => p[0]);
const lons = ring.map((p) => p[1]);
const [lat0, lat1, lon0, lon1] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
const KM_LON = 111.32 * Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
const nRows = Math.ceil(((lat1 - lat0) * 111.32) / BASE_KM);
const nCols = Math.ceil(((lon1 - lon0) * KM_LON) / BASE_KM);
const UNITS = BASE_KM / MIN_KM; // ячеек сетки страницы на базовый квадрат

const touchesMkad = (lat, lon, km) => {
  const dLat = km / 111.32;
  const dLon = km / KM_LON;
  return [[0, 0], [0.5, 0.5], [0.5, -0.5], [-0.5, 0.5], [-0.5, -0.5]].some(([a, b]) => insideMkad(lat + a * dLat, lon + b * dLon));
};
const countIn = (lat, lon, km) => {
  const hLat = km / 111.32 / 2;
  const hLon = km / KM_LON / 2;
  return known.filter(([a, b]) => Math.abs(a - lat) <= hLat && Math.abs(b - lon) <= hLon).length;
};

const tiles = [];
// gr/gc - левый верхний угол в единицах MIN_KM для раскладки на странице.
function addTile(lat, lon, km, gr, gc) {
  if (!touchesMkad(lat, lon, km)) return;
  if (km > MIN_KM && countIn(lat, lon, km) > SPLIT_ABOVE) {
    const dLat = km / 111.32 / 4;
    const dLon = km / KM_LON / 4;
    const half = km / 2 / MIN_KM;
    for (const [a, b, r, c] of [[1, -1, 0, 0], [1, 1, 0, 1], [-1, -1, 1, 0], [-1, 1, 1, 1]]) addTile(lat + a * dLat, lon + b * dLon, km / 2, gr + r * half, gc + c * half);
    return;
  }
  tiles.push({ n: tiles.length + 1, km, gr, gc, span: km / MIN_KM, lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)) });
}
// Строки с севера на юг, змейкой - соседние квадраты идут подряд.
for (let r = 0; r < nRows; r++) {
  const lat = lat1 - ((r + 0.5) * BASE_KM) / 111.32;
  const cols = [...Array(nCols).keys()];
  if (r % 2) cols.reverse();
  for (const c of cols) addTile(lat, lon0 + ((c + 0.5) * BASE_KM) / KM_LON, BASE_KM, r * UNITS, c * UNITS);
}
const SAVE_EVERY = 8;

const url = (t) => `https://yandex.ru/maps/213/moscow/search/${encodeURIComponent('Электрозаправки')}/?ll=${t.lon}%2C${t.lat}&z=${ZOOM_BY_KM[t.km]}`;
const cells = tiles.map((t) => `<a class="tile k${t.km}" data-n="${t.n}" href="${url(t)}" target="yandex-sweep" title="квадрат ${t.n}: ${t.km}×${t.km} км" style="grid-row:${t.gr + 1} / span ${t.span};grid-column:${t.gc + 1} / span ${t.span}">${t.n}</a>`).join('\n      ');
const count = (km) => tiles.filter((t) => t.km === km).length;

const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Объезд Яндекс.Карт — чеклист</title>
  <style>
    :root { --ink:#14161c; --muted:#6b6a64; --accent:#7c3aed; --soft:#f3eefe; --done:#16a34a; --page:#f7f7f5; --line:#e5e4de; }
    * { box-sizing: border-box; }
    body { margin: 0 auto; max-width: 1100px; padding: 1.5rem 1rem 3rem; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: var(--page); line-height: 1.5; }
    h1 { font-size: 1.6rem; margin: 0 0 .3rem; }
    .lead { color: var(--muted); margin: 0 0 1.2rem; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 1.2rem; align-items: start; }
    .card { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 1rem 1.1rem; }
    ol { padding-left: 1.2rem; margin: .4rem 0 0; display: grid; gap: .45rem; font-size: .9rem; }
    code { background: var(--soft); padding: 0 .3rem; border-radius: 4px; font-size: .85em; }
    .grid { display: grid; grid-template-columns: repeat(${nCols * UNITS}, 1fr); grid-template-rows: repeat(${nRows * UNITS}, 1fr); gap: 2px; aspect-ratio: ${nCols} / ${nRows}; }
    .tile { display: flex; align-items: center; justify-content: center; border-radius: 5px; background: var(--soft); border: 1.5px solid #d9ccfb; color: #4c1d95; font-weight: 700; font-size: .8rem; text-decoration: none; min-width: 0; overflow: hidden; }
    .tile.k2 { font-size: .68rem; background: #ece4fd; }
    .tile.k1 { font-size: .56rem; background: #e2d6fc; border-width: 1px; }
    .save-banner { display: none; margin-top: .8rem; padding: .7rem .8rem; border-radius: 10px; background: #7c3aed; color: #fff; font-size: .9rem; }
    .save-banner.show { display: block; }
    .save-banner button { margin-top: .5rem; background: #fff; color: #4c1d95; border: none; font-weight: 700; }
    .tile:hover { background: #e4d8fd; }
    .tile.next { outline: 3px solid var(--accent); outline-offset: 1px; }
    .tile.done { background: var(--done); border-color: var(--done); color: #fff; }
    .bar { height: 10px; border-radius: 99px; background: var(--line); overflow: hidden; margin: .5rem 0 .2rem; }
    .bar i { display: block; height: 100%; background: var(--done); width: 0; transition: width .3s; }
    .row { display: flex; justify-content: space-between; align-items: center; gap: .5rem; font-size: .88rem; }
    button { font: inherit; border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: .35rem .7rem; cursor: pointer; }
    .warn { margin-top: .8rem; padding: .6rem .75rem; border-radius: 10px; background: #fdf3d7; color: #7a5a07; font-size: .85rem; }
    @media (max-width: 800px) { .layout { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>Объезд Яндекс.Карт по квадратам</h1>
  <p class="lead">${tiles.length} квадратов покрывают Москву внутри МКАД: ${count(4)} по 4×4 км на окраинах, ${count(2)} по 2×2 км и ${count(1)} по 1×1 км там, где станций много — Яндекс показывает не больше 25 станций на окно, и прокрутка списка больше не подгружает. Пройдите все — и в данных не останется дыр. Страница работает без установки чего-либо: откройте файл в Google Chrome на любом компьютере (Windows или Mac).</p>
  <div class="layout">
    <div class="card">
      <div class="grid" id="grid">
      ${cells}
      </div>
      <div class="row" style="margin-top:.8rem"><span id="progress-text"></span><button id="reset">Сбросить отметки</button></div>
      <div class="bar"><i id="progress-bar"></i></div>
      <div class="save-banner" id="save-banner"><b>Пора сохранить часть объезда.</b> Во вкладке Яндекса в Network: правой кнопкой → <b>Save all as HAR with content</b> → имя <b id="save-name"></b>. Затем нажмите 🚫 (Clear), чтобы очистить журнал, и продолжайте. Иначе Chrome начнёт выбрасывать старые ответы из памяти.<br><button id="saved">Сохранил, продолжаю</button></div>
    </div>
    <div class="card">
      <b>Как проходить</b>
      <ol>
        <li>Кликните квадрат <b>1</b> — откроется вторая вкладка с Яндекс.Картами и поиском «Электрозаправки».</li>
        <li>В этой вкладке откройте DevTools: <code>F12</code> или <code>Ctrl+Shift+I</code> на Windows, <code>Cmd+Option+I</code> на Mac. Вкладка <b>Network</b> → включите <b>Preserve log</b>, фильтр <b>Fetch/XHR</b>. Затем обновите страницу: <code>F5</code> / <code>Cmd+R</code>.</li>
        <li>Дождитесь, пока на карте появятся станции (1–2 секунды). Карту не двигайте и не приближайте — квадрат уже в нужном масштабе.</li>
        <li>Вернитесь сюда и кликните следующий квадрат — он откроется в той же вкладке, запись продолжится. Пройденные квадраты зеленеют, следующий обведён.</li>
        <li><b>Каждые ${SAVE_EVERY} квадратов</b> страница попросит сохранить часть: в Network правой кнопкой → <b>Save all as HAR with content</b> (часть1.har, часть2.har…), потом 🚫 Clear. Иначе при длинной записи Chrome выбрасывает старые ответы — в объезде 24.09 так пропало 2/3 данных.</li>
        <li>После последнего квадрата сохраните последнюю часть.</li>
        <li>Перешлите все части на Mac (Telegram, почта, флешка) — импорт принимает сразу несколько файлов: <code>npm run import:yandex -- ~/Downloads/часть*.har</code>.</li>
      </ol>
      <div class="warn">Не закрывайте вкладку Яндекса и DevTools до конца объезда — иначе запись начнётся заново. Если Яндекс попросит капчу — пройдите её и продолжайте с того же квадрата.</div>
    </div>
  </div>
  <script>
    const KEY = 'yandex-sweep-done-v2';
    const SAVE_KEY = 'yandex-sweep-saved-v2';
    const SAVE_EVERY = ${SAVE_EVERY};
    const load = () => { try { return new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { return new Set(); } };
    const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify([...s])); } catch {} };
    const tiles = [...document.querySelectorAll('.tile')];
    function render() {
      const done = load();
      let next = null;
      for (const t of [...tiles].sort((a, b) => a.dataset.n - b.dataset.n)) {
        t.classList.toggle('done', done.has(t.dataset.n));
        t.classList.remove('next');
        if (!next && !done.has(t.dataset.n)) next = t;
      }
      if (next) next.classList.add('next');
      document.getElementById('progress-text').textContent = 'Пройдено ' + done.size + ' из ' + tiles.length;
      document.getElementById('progress-bar').style.width = (100 * done.size / tiles.length) + '%';
      let saved = 0;
      try { saved = Number(localStorage.getItem(SAVE_KEY) || 0); } catch {}
      const due = done.size - saved >= SAVE_EVERY || (done.size === tiles.length && done.size > saved);
      document.getElementById('save-banner').classList.toggle('show', due);
      document.getElementById('save-name').textContent = 'часть' + (Math.floor(saved / SAVE_EVERY) + 1) + '.har';
    }
    document.getElementById('saved').addEventListener('click', () => { try { localStorage.setItem(SAVE_KEY, String(load().size)); } catch {} render(); });
    tiles.forEach((t) => t.addEventListener('click', () => { const s = load(); s.add(t.dataset.n); save(s); setTimeout(render, 0); }));
    document.getElementById('reset').addEventListener('click', () => { if (confirm('Сбросить все отметки?')) { save(new Set()); try { localStorage.setItem(SAVE_KEY, '0'); } catch {} render(); } });
    render();
  </script>
</body>
</html>
`;
writeFileSync(join(__dirname, '..', 'tools', 'yandex-sweep.html'), html);
console.log(`tools/yandex-sweep.html: ${tiles.length} квадратов (4 км: ${count(4)}, 2 км: ${count(2)}, 1 км: ${count(1)})`);
