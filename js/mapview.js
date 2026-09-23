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

export function initMap() {
  const demandSource = new ol.source.Vector();
  const centersSource = new ol.source.Vector();
  const stationsSource = new ol.source.Vector();
  const stationsClusterSource = new ol.source.Cluster({ distance: STATION_CLUSTER_DISTANCE_PX, source: stationsSource });
  const neighborsSource = new ol.source.Vector();
  const candidateSource = new ol.source.Vector();

  const demandLayer = new ol.layer.Heatmap({
    source: demandSource,
    blur: 18,
    radius: 10,
    weight: (feature) => feature.get('weight'),
    gradient: ['#fff2cc', '#e69138', '#990000'],
    opacity: 0.55,
  });
  const centersLayer = new ol.layer.Vector({ source: centersSource });
  const stationsLayer = new ol.layer.Vector({ source: stationsClusterSource, style: stationClusterStyle });
  const neighborsLayer = new ol.layer.Vector({ source: neighborsSource });
  const candidateLayer = new ol.layer.Vector({ source: candidateSource });

  const map = new ol.Map({
    target: 'map',
    layers: [new ol.layer.Tile({ source: new ol.source.OSM() }), demandLayer, centersLayer, stationsLayer, neighborsLayer, candidateLayer],
    view: new ol.View({ center: ol.proj.fromLonLat(MOSCOW_CENTER_LONLAT), zoom: 10 }),
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
    const feature = map.forEachFeatureAtPixel(evt.pixel, (f) => f, { layerFilter: (l) => l !== demandLayer });
    const hint = feature && clusterAwareHint(feature);
    if (hint) {
      tooltipEl.textContent = hint;
      tooltipEl.style.display = 'block';
      tooltipOverlay.setPosition(evt.coordinate);
    } else {
      tooltipEl.style.display = 'none';
    }
  });

  return { map, demandSource, centersSource, stationsSource, stationsLayer, neighborsSource, candidateSource };
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
  const radius = Math.min(26, 11 + Math.sqrt(count) * 2.2);
  return new ol.style.Style({
    image: new ol.style.Circle({
      radius,
      fill: new ol.style.Fill({ color: 'rgba(42, 120, 214, 0.88)' }),
      stroke: new ol.style.Stroke({ color: '#fff', width: 2 }),
    }),
    text: new ol.style.Text({
      text: String(count),
      font: 'bold 12px system-ui, sans-serif',
      fill: new ol.style.Fill({ color: '#fff' }),
    }),
  });
}

export function renderDemandLayer({ demandSource, cells, totalDemandPerCell }) {
  demandSource.clear();
  let max = 0;
  for (const v of totalDemandPerCell) max = Math.max(max, v);
  if (max === 0) max = 1;
  const features = [];
  for (let i = 0; i < cells.length; i++) {
    const v = totalDemandPerCell[i];
    if (v <= 0) continue;
    const f = new ol.Feature({ geometry: new ol.geom.Point(toMapCoord(cells[i].lat, cells[i].lon)) });
    f.set('weight', v / max);
    features.push(f);
  }
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
