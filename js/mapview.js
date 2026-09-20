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

export function initMap() {
  const demandSource = new ol.source.Vector();
  const centersSource = new ol.source.Vector();
  const stationsSource = new ol.source.Vector();
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
  const stationsLayer = new ol.layer.Vector({ source: stationsSource });
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
    if (feature && feature.get('hint')) {
      tooltipEl.textContent = feature.get('hint');
      tooltipEl.style.display = 'block';
      tooltipOverlay.setPosition(evt.coordinate);
    } else {
      tooltipEl.style.display = 'none';
    }
  });

  return { map, demandSource, centersSource, stationsSource, neighborsSource, candidateSource };
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

export function renderCentersLayer({ centersSource, centers }) {
  centersSource.clear();
  const features = [];
  for (const c of centers) {
    const f = new ol.Feature({ geometry: new ol.geom.Point(toMapCoord(c.lat, c.lon)) });
    f.setStyle(circleStyle({ radiusPx: 3, fillColor: '#ccc', strokeColor: '#666' }));
    f.set('hint', `${c.id}\nрезерв ${c.reserve_MVA} МВА`);
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
