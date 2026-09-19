// Слои карты (Leaflet). Не модуль расчёта — только отрисовка того, что
// посчитано в equilibrium.js. Раздел 12.1.

const MOSCOW_CENTER = [55.751, 37.618];

export function initMap() {
  const map = L.map('map', { preferCanvas: true }).setView(MOSCOW_CENTER, 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 18,
  }).addTo(map);

  const demandLayer = L.layerGroup().addTo(map);
  const stationsLayer = L.layerGroup().addTo(map);
  const centersLayer = L.layerGroup().addTo(map);
  const candidateLayer = L.layerGroup().addTo(map);
  const neighborsLayer = L.layerGroup().addTo(map);

  return { map, demandLayer, stationsLayer, centersLayer, candidateLayer, neighborsLayer };
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

function colorForDemand(t) {
  // t в [0,1], простая светло-жёлтая -> тёмно-красная шкала.
  const r = Math.round(255 - t * 40);
  const g = Math.round(230 - t * 180);
  const b = Math.round(150 - t * 140);
  return `rgb(${r},${Math.max(g, 20)},${Math.max(b, 10)})`;
}

export function renderDemandLayer({ demandLayer, cells, totalDemandPerCell }) {
  demandLayer.clearLayers();
  let max = 0;
  for (const v of totalDemandPerCell) max = Math.max(max, v);
  if (max === 0) max = 1;
  for (let i = 0; i < cells.length; i++) {
    const v = totalDemandPerCell[i];
    if (v <= 0) continue;
    const t = v / max;
    L.circleMarker([cells[i].lat, cells[i].lon], {
      radius: 2 + t * 3,
      color: colorForDemand(t),
      fillColor: colorForDemand(t),
      fillOpacity: 0.5,
      stroke: false,
    }).addTo(demandLayer);
  }
}

export function renderStationsLayer({ stationsLayer, stations, activeStations, Uarr, onClickStation }) {
  stationsLayer.clearLayers();
  for (let j = 0; j < stations.length; j++) {
    if (!activeStations[j]) continue;
    const u = Uarr[j];
    const marker = L.circleMarker([stations[j].lat, stations[j].lon], {
      radius: 4 + Math.sqrt(stations[j].posts) * 2,
      color: '#333',
      weight: 1,
      fillColor: colorForU(u),
      fillOpacity: 0.85,
    });
    marker.bindTooltip(
      `${stations[j].id} · ${stations[j].operator}<br>${stations[j].P_kW} кВт, ${stations[j].posts} пост(ов)<br>U=${(u * 100).toFixed(1)}%`
    );
    if (onClickStation) marker.on('click', () => onClickStation(j));
    marker.addTo(stationsLayer);
  }
}

export function renderCentersLayer({ centersLayer, centers }) {
  centersLayer.clearLayers();
  for (const c of centers) {
    L.circleMarker([c.lat, c.lon], {
      radius: 3,
      color: '#666',
      fillColor: '#ccc',
      fillOpacity: 0.7,
    })
      .bindTooltip(`${c.id}<br>резерв ${c.reserve_MVA} МВА`)
      .addTo(centersLayer);
  }
}

export function renderCandidate({ candidateLayer, candidate }) {
  candidateLayer.clearLayers();
  if (!candidate) return;
  L.marker([candidate.lat, candidate.lon], {
    icon: L.divIcon({ className: 'candidate-icon', html: '★', iconSize: [20, 20] }),
  })
    .bindTooltip('Кандидат')
    .addTo(candidateLayer);
}

// 6.3. Соседи, окрашенные по ΔS: красный - теряет, синий - выигрывает,
// размер кружка пропорционален |ΔS|.
export function renderNeighbors({ neighborsLayer, stations, neighborDeltas }) {
  neighborsLayer.clearLayers();
  for (const { globalIdx, deltaS } of neighborDeltas) {
    const st = stations[globalIdx];
    const color = deltaS < 0 ? '#c0392b' : '#2980b9';
    L.circleMarker([st.lat, st.lon], {
      radius: 3 + Math.min(15, Math.abs(deltaS) * 3),
      color,
      fillColor: color,
      fillOpacity: 0.5,
      weight: 1,
    })
      .bindTooltip(`${st.id}: ΔS=${deltaS.toFixed(2)} сессий/сутки`)
      .addTo(neighborsLayer);
  }
}
