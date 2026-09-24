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

const STEP_KM = 4;
const ZOOM = 13.4; // окно ~5 км - квадрат с запасом на перекрытие
const lats = ring.map((p) => p[0]);
const lons = ring.map((p) => p[1]);
const [lat0, lat1, lon0, lon1] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
const dLat = STEP_KM / 111.32;
const dLon = STEP_KM / (111.32 * Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180));
const nRows = Math.ceil((lat1 - lat0) / dLat);
const nCols = Math.ceil((lon1 - lon0) / dLon);

// Строки с севера на юг, змейкой - соседние квадраты идут подряд.
const tiles = [];
for (let r = 0; r < nRows; r++) {
  const lat = lat1 - (r + 0.5) * dLat;
  const cols = [...Array(nCols).keys()];
  if (r % 2) cols.reverse();
  for (const c of cols) {
    const lon = lon0 + (c + 0.5) * dLon;
    const probe = [[0, 0], [0.5, 0.5], [0.5, -0.5], [-0.5, 0.5], [-0.5, -0.5]];
    if (!probe.some(([a, b]) => insideMkad(lat + a * dLat, lon + b * dLon))) continue;
    tiles.push({ n: tiles.length + 1, r, c, lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)) });
  }
}

const url = (t) => `https://yandex.ru/maps/213/moscow/search/${encodeURIComponent('Электрозаправки')}/?ll=${t.lon}%2C${t.lat}&z=${ZOOM}`;
const cells = tiles.map((t) => `<a class="tile" data-n="${t.n}" href="${url(t)}" target="yandex-sweep" style="grid-row:${t.r + 1};grid-column:${t.c + 1}">${t.n}</a>`).join('\n      ');

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
    .grid { display: grid; grid-template-columns: repeat(${nCols}, 1fr); grid-template-rows: repeat(${nRows}, 1fr); gap: 4px; aspect-ratio: ${nCols} / ${nRows}; }
    .tile { display: flex; align-items: center; justify-content: center; border-radius: 6px; background: var(--soft); border: 1.5px solid #d9ccfb; color: #4c1d95; font-weight: 700; font-size: .85rem; text-decoration: none; }
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
  <p class="lead">${tiles.length} квадратов по ${STEP_KM}×${STEP_KM} км покрывают Москву внутри МКАД. Пройдите все — и в данных не останется дыр.</p>
  <div class="layout">
    <div class="card">
      <div class="grid" id="grid">
      ${cells}
      </div>
      <div class="row" style="margin-top:.8rem"><span id="progress-text"></span><button id="reset">Сбросить отметки</button></div>
      <div class="bar"><i id="progress-bar"></i></div>
    </div>
    <div class="card">
      <b>Как проходить</b>
      <ol>
        <li>Кликните квадрат <b>1</b> — откроется вторая вкладка с Яндекс.Картами и поиском «Электрозаправки».</li>
        <li>В этой вкладке откройте DevTools (<code>Cmd+Option+I</code>) → <b>Network</b>, включите <b>Preserve log</b>, фильтр <b>Fetch/XHR</b>. Затем обновите страницу (<code>Cmd+R</code>).</li>
        <li><b>Главное:</b> в списке результатов слева <b>прокрутите до самого конца</b>, пока не перестанут подгружаться новые станции. Яндекс сразу отдаёт только 25 — остальные только при прокрутке.</li>
        <li>Вернитесь сюда и кликните следующий квадрат — он откроется в той же вкладке, запись продолжится. Пройденные квадраты зеленеют, следующий обведён.</li>
        <li>Когда все квадраты зелёные: во вкладке Яндекса в Network — правой кнопкой → <b>Save all as HAR with content</b>.</li>
        <li>Пришлите файл — или сами: <code>npm run import:yandex -- ~/Downloads/файл.har</code>.</li>
      </ol>
      <div class="warn">Не закрывайте вкладку Яндекса и DevTools до конца объезда — иначе запись начнётся заново. Если Яндекс попросит капчу — пройдите её и продолжайте с того же квадрата.</div>
    </div>
  </div>
  <script>
    const KEY = 'yandex-sweep-done-v1';
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
    }
    tiles.forEach((t) => t.addEventListener('click', () => { const s = load(); s.add(t.dataset.n); save(s); setTimeout(render, 0); }));
    document.getElementById('reset').addEventListener('click', () => { if (confirm('Сбросить все отметки?')) { save(new Set()); render(); } });
    render();
  </script>
</body>
</html>
`;
writeFileSync(join(__dirname, '..', 'tools', 'yandex-sweep.html'), html);
console.log(`tools/yandex-sweep.html: ${tiles.length} квадратов ${STEP_KM}×${STEP_KM} км (сетка ${nRows}×${nCols}), z=${ZOOM}`);
