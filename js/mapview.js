// Слои карты (OpenLayers + OSM-тайлы). Не модуль расчёта — только отрисовка
// того, что посчитано в equilibrium.js. Раздел 12.1.
//
// Библиотека карты сознательно не Leaflet (его автор — гражданин Украины,
// для конкурса РФ это репутационный риск): OpenLayers — международный
// open-source проект (изначально MetaCarta, США), без единого привязанного
// автора. Яндекс.Карты не подошли — платный тариф. OSM-тайлы — открытый
// краудсорс-проект, не привязан к конкретному человеку/стране.
//
// Подключается глобальным <script> (dist/ol.js, UMD-сборка, глобальная
// переменная `ol`), а не через ESM-импорты отдельных подпутей пакета.
// ESM-путь пробовали первым - деградировал: у esm.sh/jsdelivr `ol/Map.js` и
// `ol/View.js` компилируются в независимые чанки, и `new View()` из одного
// чанка не проходит `instanceof` в конструкторе Map из другого - OL решает,
// что это Promise, и падает на `.then is not a function`. Подробности и
// сколько на это ушло времени - docs/journal.md.

const MOSCOW_CENTER_LONLAT = [37.618, 55.751]; // OL: [lon, lat]

// Кластеризация станций (как на картах АЗС): близкие точки на текущем
// зуме схлопываются в один кружок с числом, при приближении расходятся
// обратно на реальные координаты. Расстояние - в пикселях экрана, поэтому
// поведение не зависит от того, сколько всего станций в data/stations.json -
// добавление новых станций позже не требует правок здесь (source у
// ol.source.Cluster просто перегруппировывает то, что в нём есть).
const STATION_CLUSTER_DISTANCE_PX = 40;

// Бирюзовый - чтобы медленные не сливались ни с фиолетовыми зонами спроса,
// ни с быстрыми станциями (зелёный→красный по загрузке). Серые 3.5 px на
// фиолетовом фоне пользователь не видел вовсе (25.09).
const SLOW_STYLE = new ol.style.Style({
  image: new ol.style.Circle({
    radius: 5,
    fill: new ol.style.Fill({ color: '#0d9488' }),
    stroke: new ol.style.Stroke({ color: '#fff', width: 1.5 }),
  }),
});

export function initMap() {
  const demandSource = new ol.source.Vector();
  const centersSource = new ol.source.Vector();
  const stationsSource = new ol.source.Vector();
  const stationsClusterSource = new ol.source.Cluster({ distance: STATION_CLUSTER_DISTANCE_PX, source: stationsSource });
  const neighborsSource = new ol.source.Vector();
  const candidateSource = new ol.source.Vector();
  const portfolioSource = new ol.source.Vector();
  const mkadSource = new ol.source.Vector();
  const slowSource = new ol.source.Vector();

  // Спрос - шестиугольные зоны как на карте спроса у таксистов (Яндекс Про):
  // дискретные ступени фиолетового вместо размытого heatmap, стиль у каждой
  // зоны свой (renderDemandLayer), слой только рисует.
  const demandLayer = new ol.layer.Vector({ source: demandSource });
  // Центры питания - только с зума 11: на общем плане Москвы 227 молний
  // превращаются в кашу поверх зон спроса.
  const centersLayer = new ol.layer.Vector({ source: centersSource, minZoom: 11 });
  const stationsLayer = new ol.layer.Vector({ source: stationsClusterSource, style: stationClusterStyle });
  const neighborsLayer = new ol.layer.Vector({ source: neighborsSource });
  const candidateLayer = new ol.layer.Vector({ source: candidateSource });
  const portfolioLayer = new ol.layer.Vector({ source: portfolioSource, zIndex: 5 });
  // Медленные AC-станции (data/stations-slow.json) - в модель не входят,
  // показываются по галочке для справки; по умолчанию скрыты.
  const slowLayer = new ol.layer.Vector({ source: slowSource, visible: false, style: SLOW_STYLE, zIndex: 3 });
  // Граница модели: всё считается для Москвы внутри МКАД (data/mkad.json).
  const mkadLayer = new ol.layer.Vector({
    source: mkadSource,
    style: new ol.style.Style({ stroke: new ol.style.Stroke({ color: 'rgba(76, 29, 149, 0.55)', width: 2, lineDash: [8, 6] }) }),
  });

  const map = new ol.Map({
    target: 'map',
    // className - чтобы CSS обесцветил только подложку (.basemap), а не
    // слои поверх: на серой карте фиолетовые зоны спроса читаются лучше.
    layers: [new ol.layer.Tile({ source: new ol.source.OSM(), className: 'basemap' }), demandLayer, mkadLayer, slowLayer, centersLayer, stationsLayer, neighborsLayer, portfolioLayer, candidateLayer],
    view: new ol.View({ center: ol.proj.fromLonLat(MOSCOW_CENTER_LONLAT), zoom: 10.4 }),
  });

  // Общий тултип по наведению (аналог bindTooltip/hintContent).
  const tooltipEl = document.createElement('div');
  tooltipEl.className = 'ol-tooltip';
  tooltipEl.style.display = 'none';
  // map.addOverlay ниже сам переносит element в свой overlay-контейнер -
  // вручную добавлять в DOM не нужно.
  const tooltipOverlay = new ol.Overlay({ element: tooltipEl, offset: [12, 0], positioning: 'center-left' });
  map.addOverlay(tooltipOverlay);
  map.on('pointermove', (evt) => {
    if (evt.dragging) {
      tooltipEl.style.display = 'none';
      return;
    }
    const feature =
      map.forEachFeatureAtPixel(evt.pixel, (f) => f, { layerFilter: (l) => l !== demandLayer }) ||
      map.forEachFeatureAtPixel(evt.pixel, (f) => f, { layerFilter: (l) => l === demandLayer });
    const hint = feature && clusterAwareHint(feature);
    if (hint) {
      tooltipEl.textContent = hint;
      tooltipEl.style.display = 'block';
      tooltipOverlay.setPosition(evt.coordinate);
    } else {
      tooltipEl.style.display = 'none';
    }
  });

  return { map, demandSource, centersSource, stationsSource, stationsLayer, neighborsSource, candidateSource, portfolioSource, mkadSource, slowSource, slowLayer };
}

// Клик по карте (app.js) должен отличать клик по кластеру (несколько
// станций под курсором) от клика по пустому месту/одиночной станции -
// первое приближает карту к границам кластера, второе ставит кандидата.
// Возвращает координаты для fit() или null, если клик был не по кластеру.
export function clusterExtentAtPixel(map, stationsLayer, pixel) {
  const feature = map.forEachFeatureAtPixel(pixel, (f) => f, { layerFilter: (l) => l === stationsLayer });
  const members = feature && feature.get('features');
  if (!members || members.length <= 1) return null;
  return ol.extent.boundingExtent(members.map((f) => f.getGeometry().getCoordinates()));
}

function clusterAwareHint(feature) {
  const members = feature.get('features');
  if (!members) return feature.get('hint');
  if (members.length === 1) return members[0].get('hint');
  return `${members.length} станций рядом — приблизьте карту, чтобы увидеть их отдельно`;
}

// Координата клика по карте (проекция OL) -> {lat, lng}. Инкапсулирует OL,
// чтобы app.js не знал о конкретной картографической библиотеке.
export function coordToLatLng(coordinate) {
  const [lon, lat] = ol.proj.toLonLat(coordinate);
  return { lat, lng: lon };
}

function toMapCoord(lat, lon) {
  return ol.proj.fromLonLat([lon, lat]);
}

// Загрузка U (0-1) -> цвет. Диапазон 0-40%, т.к. типичная загрузка сети
// низкая (раздел 14: "при нынешней загрузке около 10%").
function colorForU(u) {
  const t = Math.max(0, Math.min(1, u / 0.4));
  const r = Math.round(40 + t * 180);
  const g = Math.round(160 - t * 130);
  const b = 40;
  return `rgb(${r},${g},${b})`;
}

function circleStyle({ radiusPx, fillColor, strokeColor = '#333', strokeWidth = 1 }) {
  return new ol.style.Style({
    image: new ol.style.Circle({
      radius: radiusPx,
      fill: new ol.style.Fill({ color: fillColor }),
      stroke: new ol.style.Stroke({ color: strokeColor, width: strokeWidth }),
    }),
  });
}

// Стиль слоя-кластера станций (ol.layer.Vector.style, вызывается заново на
// каждый рендер для каждого текущего кластера). Одиночный "кластер" из 1
// станции переиспользует уже посчитанный в renderStationsLayer стиль
// (цвет по U(h)) - его не нужно пересчитывать здесь.
function stationClusterStyle(feature) {
  const members = feature.get('features');
  if (members.length === 1) return members[0].getStyle();
  const count = members.length;
  const radius = Math.min(19, 9 + Math.sqrt(count) * 1.4);
  return new ol.style.Style({
    image: new ol.style.Circle({
      radius,
      fill: new ol.style.Fill({ color: 'rgba(30, 22, 48, 0.78)' }),
      stroke: new ol.style.Stroke({ color: 'rgba(255, 255, 255, 0.9)', width: 1.5 }),
    }),
    text: new ol.style.Text({
      text: String(count),
      font: '600 11px system-ui, sans-serif',
      fill: new ol.style.Fill({ color: '#fff' }),
    }),
  });
}

// --- Зоны спроса: шестиугольная сетка ---
// Радиус шестиугольника (центр -> вершина) на земле. Ячейки cells.json -
// 1x1 км, зона ~0.85 км покрывает в среднем ~2 ячейки: плотность в зоне -
// среднее по попавшим в неё ячейкам, а не сумма, иначе число ячеек в зоне
// (1-3 из-за несовпадения квадратной и шестиугольной сеток) давало бы муар.
const HEX_RADIUS_KM = 0.85;
// Web Mercator растягивает расстояния в 1/cos(широты) раз - на широте
// Москвы 1 км на земле = ~1.78 км "метров карты".
const MERCATOR_SCALE = 1 / Math.cos((MOSCOW_CENTER_LONLAT[1] * Math.PI) / 180);
const HEX_SIZE = HEX_RADIUS_KM * 1000 * MERCATOR_SCALE;
const SQRT3 = Math.sqrt(3);

// Ступени фиолетового (светлее -> темнее), нижние ~35% зон не красятся
// вообще - как у таксистов, подсвечено только то, где спрос выше обычного.
export const DEMAND_LEVELS = [
  { q: 0.35, fill: 'rgba(196, 181, 253, 0.38)', label: 'выше обычного' },
  { q: 0.55, fill: 'rgba(167, 139, 250, 0.48)', label: '' },
  { q: 0.72, fill: 'rgba(139, 92, 246, 0.56)', label: '' },
  { q: 0.86, fill: 'rgba(118, 56, 230, 0.64)', label: '' },
  { q: 0.95, fill: 'rgba(84, 30, 170, 0.74)', label: 'пиковый' },
];
const HEX_STROKE = new ol.style.Stroke({ color: 'rgba(255, 255, 255, 0.75)', width: 1 });
const HEX_STYLES = DEMAND_LEVELS.map((l) => new ol.style.Style({ fill: new ol.style.Fill({ color: l.fill }), stroke: HEX_STROKE }));

// pointy-top шестиугольники, осевые координаты (q, r) - стандартная схема
// с округлением в кубических координатах.
function hexKeyForPoint(x, y) {
  const qf = ((SQRT3 / 3) * x - (1 / 3) * y) / HEX_SIZE;
  const rf = ((2 / 3) * y) / HEX_SIZE;
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return `${q},${r}`;
}

function hexPolygon(key) {
  const [q, r] = key.split(',').map(Number);
  const cx = HEX_SIZE * SQRT3 * (q + r / 2);
  const cy = HEX_SIZE * 1.5 * r;
  const ring = [];
  for (let k = 0; k <= 6; k++) {
    const a = (Math.PI / 180) * (60 * (k % 6) - 30);
    ring.push([cx + HEX_SIZE * Math.cos(a), cy + HEX_SIZE * Math.sin(a)]);
  }
  return new ol.geom.Polygon([ring]);
}

// Разбиение ячеек по зонам не зависит от часа - считаем один раз на массив cells.
const hexIndexCache = new WeakMap();
function hexIndex(cells) {
  if (hexIndexCache.has(cells)) return hexIndexCache.get(cells);
  const groups = new Map();
  cells.forEach((c, i) => {
    const [x, y] = toMapCoord(c.lat, c.lon);
    const key = hexKeyForPoint(x, y);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  const index = [...groups].map(([key, members]) => ({ key, members, geometry: hexPolygon(key) }));
  hexIndexCache.set(cells, index);
  return index;
}

function hexDensities(index, perCell) {
  return index.map(({ members }) => members.reduce((a, i) => a + perCell[i], 0) / members.length);
}

// totalDemandPerCell - спрос в выбранный час; scaleDemandPerCell - спрос в
// пиковый час того же дня. Пороги ступеней считаются по пиковому часу и
// держатся весь день: ночью зоны гаснут, в пик загораются. Если пороги
// считать заново каждый час, картинка была бы одинаковой в любое время.
export function renderDemandLayer({ demandSource, cells, totalDemandPerCell, scaleDemandPerCell = totalDemandPerCell }) {
  demandSource.clear();
  const index = hexIndex(cells);
  const scale = hexDensities(index, scaleDemandPerCell).filter((v) => v > 0).sort((a, b) => a - b);
  if (scale.length === 0) return;
  const thresholds = DEMAND_LEVELS.map((l) => scale[Math.min(scale.length - 1, Math.floor(l.q * scale.length))]);
  const cityMean = scale.reduce((a, b) => a + b, 0) / scale.length;
  const now = hexDensities(index, totalDemandPerCell);
  const features = [];
  index.forEach((hex, k) => {
    const v = now[k];
    let level = -1;
    for (let l = 0; l < thresholds.length; l++) if (v >= thresholds[l]) level = l;
    if (level < 0) return;
    const f = new ol.Feature({ geometry: hex.geometry });
    f.setStyle(HEX_STYLES[level]);
    const perKm2 = v; // ячейка = 1 км², v - среднее по ячейкам зоны
    f.set('hint', `Спрос на зарядку: ${perKm2.toFixed(2)} заявок/ч на км²\n${(v / cityMean).toFixed(1)}× от среднего по городу в пик`);
    features.push(f);
  });
  demandSource.addFeatures(features);
}

export function renderStationsLayer({ stationsSource, stations, activeStations, Uarr, onClickStation }) {
  stationsSource.clear();
  const features = [];
  for (let j = 0; j < stations.length; j++) {
    if (!activeStations[j]) continue;
    const st = stations[j];
    const u = Uarr[j];
    const f = new ol.Feature({ geometry: new ol.geom.Point(toMapCoord(st.lat, st.lon)) });
    f.setStyle(circleStyle({ radiusPx: 4 + Math.sqrt(st.posts) * 2, fillColor: colorForU(u) }));
    f.set('hint', `${st.id} · ${st.operator}\n${st.P_kW} кВт, ${st.posts} пост(ов)\nU=${(u * 100).toFixed(1)}%`);
    if (onClickStation) f.set('onClick', () => onClickStation(j));
    features.push(f);
  }
  stationsSource.addFeatures(features);
}

// ⚡ ("High Voltage Sign" в Unicode) - визуально отличает центры питания
// от станций (кружки по загрузке U(h)) и кандидата (звезда). Раньше были
// еле заметные серые точки без объяснения, что это. У эмодзи свой фиксированный
// жёлто-чёрный цвет (CSS fill/color на цветные эмодзи-глифы не действует),
// на светлых тайлах (бежевые/жёлтые дороги OSM) он терялся - поэтому
// кружок-подложка тёмного цвета под ним, как у обычных пинов на картах,
// а не одна лишь текстовая глифа.
const CENTER_ICON_STYLE = [
  new ol.style.Style({
    image: new ol.style.Circle({
      radius: 9,
      fill: new ol.style.Fill({ color: '#2b2540' }),
      stroke: new ol.style.Stroke({ color: '#fff', width: 1.5 }),
    }),
  }),
  new ol.style.Style({
    text: new ol.style.Text({
      text: '⚡',
      font: '12px sans-serif',
    }),
  }),
];

export function renderCentersLayer({ centersSource, centers }) {
  centersSource.clear();
  const features = [];
  for (const c of centers) {
    const f = new ol.Feature({ geometry: new ol.geom.Point(toMapCoord(c.lat, c.lon)) });
    f.setStyle(CENTER_ICON_STYLE);
    f.set('hint', `⚡ ${c.id} (центр питания)\nрезерв ${c.reserve_MVA} МВА (оценка)`);
    features.push(f);
  }
  centersSource.addFeatures(features);
}

export function renderCandidate({ candidateSource, candidate }) {
  candidateSource.clear();
  if (!candidate) return;
  const f = new ol.Feature({ geometry: new ol.geom.Point(toMapCoord(candidate.lat, candidate.lon)) });
  f.setStyle(
    new ol.style.Style({
      text: new ol.style.Text({
        text: '★',
        font: '20px sans-serif',
        fill: new ol.style.Fill({ color: '#d4af00' }),
        stroke: new ol.style.Stroke({ color: '#000', width: 2 }),
      }),
    })
  );
  f.set('hint', 'Кандидат');
  candidateSource.addFeature(f);
}

// 6.3. Соседи, окрашенные по ΔS: красный - теряет, синий - выигрывает,
// радиус кружка пропорционален |ΔS|.
export function renderNeighbors({ neighborsSource, stations, neighborDeltas }) {
  neighborsSource.clear();
  const features = [];
  for (const { globalIdx, deltaS } of neighborDeltas) {
    const st = stations[globalIdx];
    const color = deltaS < 0 ? '#c0392b' : '#2980b9';
    const f = new ol.Feature({ geometry: new ol.geom.Point(toMapCoord(st.lat, st.lon)) });
    f.setStyle(circleStyle({ radiusPx: 3 + Math.min(15, Math.abs(deltaS) * 3), fillColor: color, strokeColor: color }));
    f.set('hint', `${st.id}: ΔS=${deltaS.toFixed(2)} сессий/сутки`);
    features.push(f);
  }
  neighborsSource.addFeatures(features);
}

// Модуль 8: рекомендованные моделью площадки (фиолетовые пины с номером
// шага жадного выбора) и выбор традиционным способом (серые квадраты) -
// для наглядного сравнения, где разошлись подходы.
// Уровень "ставить" - золотая обводка; "если сеть подтвердит дешёвое
// присоединение" - светлее, с белой обводкой.
function portfolioPinStyle(rank, conditional) {
  return [
    new ol.style.Style({
      image: new ol.style.Circle({
        radius: 14,
        fill: new ol.style.Fill({ color: conditional ? '#8b5cf6' : '#6d28d9' }),
        stroke: new ol.style.Stroke({ color: conditional ? '#fff' : '#fbbf24', width: 3 }),
      }),
      text: new ol.style.Text({ text: String(rank), font: '700 12px system-ui, sans-serif', fill: new ol.style.Fill({ color: '#fff' }) }),
    }),
  ];
}

function traditionalPinStyle(rank) {
  return new ol.style.Style({
    image: new ol.style.RegularShape({
      points: 4,
      radius: 12,
      angle: Math.PI / 4,
      fill: new ol.style.Fill({ color: 'rgba(82, 81, 78, 0.9)' }),
      stroke: new ol.style.Stroke({ color: '#fff', width: 2 }),
    }),
    text: new ol.style.Text({ text: String(rank), font: '600 11px system-ui, sans-serif', fill: new ol.style.Fill({ color: '#fff' }) }),
  });
}


export function renderPortfolio({ portfolioSource, portfolio, showModel = true, showTraditional = false }) {
  portfolioSource.clear();
  if (!portfolio) return;
  const features = [];
  if (showTraditional) {
    (portfolio.traditional?.picks || []).forEach((p, k) => {
      const f = new ol.Feature({ geometry: new ol.geom.Point(toMapCoord(p.lat, p.lon)) });
      f.setStyle(traditionalPinStyle(k + 1));
      f.set('hint', `Традиционный выбор №${k + 1} · ${p.kind}${p.name ? ` «${p.name}»` : ''}\n${p.omega} · ${(p.sessions_2026 ?? 0).toFixed(1)} → ${(p.sessions_2030 ?? 0).toFixed(1)} сессий/сут (2026 → 2030)\nновых для сети: +${(p.new_demand_2026 ?? 0).toFixed(1)} → +${(p.new_demand_2030 ?? 0).toFixed(1)}`);
      f.set('portfolioPick', p);
      features.push(f);
    });
  }
  if (showModel) {
    (portfolio.model?.picks || []).forEach((p, k) => {
      const f = new ol.Feature({ geometry: new ol.geom.Point(toMapCoord(p.lat, p.lon)) });
      f.setStyle(portfolioPinStyle(k + 1, false));
      f.set('hint', `Рекомендация модели №${k + 1} · ${p.kind}${p.name ? ` «${p.name}»` : ''}\n${p.omega} · ${(p.sessions_2026 ?? 0).toFixed(1)} → ${(p.sessions_2030 ?? 0).toFixed(1)} сессий/сут (2026 → 2030)\nновых для сети: +${(p.new_demand_2026 ?? 0).toFixed(1)} → +${(p.new_demand_2030 ?? 0).toFixed(1)}\nклик — полный паспорт`);
      f.set('portfolioPick', p);
      features.push(f);
    });
  }
  portfolioSource.addFeatures(features);
}

export function portfolioPickAtPixel(map, pixel) {
  return map.forEachFeatureAtPixel(pixel, (f) => f.get('portfolioPick') || null) || null;
}

export function renderMkad({ mkadSource, ring }) {
  mkadSource.clear();
  const coords = ring.map(([lat, lon]) => toMapCoord(lat, lon));
  coords.push(coords[0]);
  mkadSource.addFeature(new ol.Feature({ geometry: new ol.geom.LineString(coords) }));
}

export function renderSlowStations({ slowSource, stations }) {
  slowSource.clear();
  slowSource.addFeatures(
    stations.map((st) => {
      const f = new ol.Feature({ geometry: new ol.geom.Point(toMapCoord(st.lat, st.lon)) });
      f.set('hint', `Медленная зарядка (AC) · ${st.operator}\nв модель не входит: другой сценарий — машина стоит часами`);
      return f;
    })
  );
}
