// Шестиугольная сетка зон - одна и та же на карте (mapview.js) и в офлайн-
// расчёте зон (scripts/compute-zones.js). Чистые функции без OpenLayers:
// координаты в Web Mercator (EPSG:3857), как у ol.proj.fromLonLat.

// Радиус шестиугольника (центр -> вершина) на земле. Ячейки cells.json -
// 1x1 км, зона ~0.85 км покрывает в среднем ~2 ячейки.
export const HEX_RADIUS_KM = 0.85;
const R_EARTH = 6378137;
const MOSCOW_LAT = 55.751;
// Web Mercator растягивает расстояния в 1/cos(широты) раз - на широте
// Москвы 1 км на земле = ~1.78 км "метров карты".
const MERCATOR_SCALE = 1 / Math.cos((MOSCOW_LAT * Math.PI) / 180);
export const HEX_SIZE = HEX_RADIUS_KM * 1000 * MERCATOR_SCALE;
const SQRT3 = Math.sqrt(3);

export function toMercator(lat, lon) {
  const x = (R_EARTH * lon * Math.PI) / 180;
  const y = R_EARTH * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}

export function fromMercator(x, y) {
  const lon = (x / R_EARTH) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / R_EARTH)) - Math.PI / 2) * (180 / Math.PI);
  return [lat, lon];
}

// pointy-top шестиугольники, осевые координаты (q, r) - стандартная схема
// с округлением в кубических координатах.
export function hexKeyForPoint(x, y) {
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

export function hexCenter(key) {
  const [q, r] = key.split(',').map(Number);
  return [HEX_SIZE * SQRT3 * (q + r / 2), HEX_SIZE * 1.5 * r];
}

export function hexRing(key) {
  const [cx, cy] = hexCenter(key);
  const ring = [];
  for (let k = 0; k <= 6; k++) {
    const a = (Math.PI / 180) * (60 * (k % 6) - 30);
    ring.push([cx + HEX_SIZE * Math.cos(a), cy + HEX_SIZE * Math.sin(a)]);
  }
  return ring;
}

export const hexKeyForLatLon = (lat, lon) => hexKeyForPoint(...toMercator(lat, lon));
