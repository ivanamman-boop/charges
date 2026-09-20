// Слои карты (Яндекс.Карты JS API 2.1). Не модуль расчёта — только
// отрисовка того, что посчитано в equilibrium.js. Раздел 12.1.
//
// Библиотека карты сознательно не Leaflet (его автор — гражданин Украины,
// для конкурса РФ это репутационный риск) и тайлы не OSM — используются
// Яндекс.Карты целиком, включая картографическую подложку.

const MOSCOW_CENTER = [55.751, 37.618];

export function initMap() {
  return new Promise((resolve, reject) => {
    if (typeof ymaps === 'undefined') {
      reject(new Error('Яндекс.Карты не загрузились — проверьте API-ключ в index.html (см. комментарий у тега script)'));
      return;
    }
    // С неверным/отсутствующим ключом API грузится, но ymaps.ready() может
    // никогда не вызвать колбэк (см. journal.md) — без таймаута страница
    // молча виснет на экране загрузки.
    const timeout = setTimeout(() => {
      reject(new Error('Яндекс.Карты не инициализировались за 8с — похоже, API-ключ в index.html неверный или не указан (developer.tech.yandex.ru)'));
    }, 8000);
    // ymaps.ready() может сработать даже с неверным ключом (базовое API
    // грузится, но дальнейшие шаги - карта/модули - зависают молча), поэтому
    // таймаут снимаем только один раз всё действительно готово, перед resolve.
    ymaps.ready(() => {
      ymaps.modules.require(['Heatmap'], (Heatmap) => {
        const map = new ymaps.Map('map', { center: MOSCOW_CENTER, zoom: 10, controls: ['zoomControl'] }, { suppressMapOpenBlock: true });

        const stationsLayer = new ymaps.GeoObjectCollection();
        const centersLayer = new ymaps.GeoObjectCollection();
        const candidateLayer = new ymaps.GeoObjectCollection();
        const neighborsLayer = new ymaps.GeoObjectCollection();
        map.geoObjects.add(centersLayer);
        map.geoObjects.add(stationsLayer);
        map.geoObjects.add(neighborsLayer);
        map.geoObjects.add(candidateLayer);

        const demandHeatmap = new Heatmap([], {
          radius: 14,
          dissipating: true,
          opacity: 0.55,
          gradient: { 0.1: '#fff2cc', 0.5: '#e69138', 1: '#990000' },
        });
        demandHeatmap.setMap(map);

        clearTimeout(timeout);
        resolve({ map, stationsLayer, centersLayer, candidateLayer, neighborsLayer, demandHeatmap });
      });
    });
  });
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

export function renderDemandLayer({ demandHeatmap, cells, totalDemandPerCell }) {
  let max = 0;
  for (const v of totalDemandPerCell) max = Math.max(max, v);
  if (max === 0) max = 1;
  const points = [];
  for (let i = 0; i < cells.length; i++) {
    const v = totalDemandPerCell[i];
    if (v <= 0) continue;
    points.push({ type: 'Feature', id: i, geometry: { type: 'Point', coordinates: [cells[i].lat, cells[i].lon] }, properties: { weight: v / max } });
  }
  demandHeatmap.setData({ type: 'FeatureCollection', features: points });
}

export function renderStationsLayer({ stationsLayer, stations, activeStations, Uarr, onClickStation }) {
  stationsLayer.removeAll();
  for (let j = 0; j < stations.length; j++) {
    if (!activeStations[j]) continue;
    const st = stations[j];
    const u = Uarr[j];
    const radiusM = 90 + Math.sqrt(st.posts) * 40;
    const circle = new ymaps.Circle(
      [[st.lat, st.lon], radiusM],
      { hintContent: `${st.id} · ${st.operator}\n${st.P_kW} кВт, ${st.posts} пост(ов)\nU=${(u * 100).toFixed(1)}%` },
      { fillColor: colorForU(u), fillOpacity: 0.85, strokeColor: '#333', strokeWidth: 1, strokeOpacity: 1 }
    );
    if (onClickStation) circle.events.add('click', () => onClickStation(j));
    stationsLayer.add(circle);
  }
}

export function renderCentersLayer({ centersLayer, centers }) {
  centersLayer.removeAll();
  for (const c of centers) {
    const circle = new ymaps.Circle(
      [[c.lat, c.lon], 70],
      { hintContent: `${c.id}\nрезерв ${c.reserve_MVA} МВА` },
      { fillColor: '#ccc', fillOpacity: 0.7, strokeColor: '#666', strokeWidth: 1 }
    );
    centersLayer.add(circle);
  }
}

export function renderCandidate({ candidateLayer, candidate }) {
  candidateLayer.removeAll();
  if (!candidate) return;
  const placemark = new ymaps.Placemark(
    [candidate.lat, candidate.lon],
    { hintContent: 'Кандидат' },
    { preset: 'islands#yellowStarIcon' }
  );
  candidateLayer.add(placemark);
}

// 6.3. Соседи, окрашенные по ΔS: красный - теряет, синий - выигрывает,
// радиус кружка пропорционален |ΔS|.
export function renderNeighbors({ neighborsLayer, stations, neighborDeltas }) {
  neighborsLayer.removeAll();
  for (const { globalIdx, deltaS } of neighborDeltas) {
    const st = stations[globalIdx];
    const color = deltaS < 0 ? '#c0392b' : '#2980b9';
    const radiusM = 60 + Math.min(400, Math.abs(deltaS) * 80);
    const circle = new ymaps.Circle(
      [[st.lat, st.lon], radiusM],
      { hintContent: `${st.id}: ΔS=${deltaS.toFixed(2)} сессий/сутки` },
      { fillColor: color, fillOpacity: 0.5, strokeColor: color, strokeWidth: 1 }
    );
    neighborsLayer.add(circle);
  }
}
