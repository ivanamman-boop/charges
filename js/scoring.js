// Быстрый балльный список площадок (фидбек Росатома: "список с баллами:
// доступность мощности, трафик, конкуренция в радиусе, тип района" + карта
// с тепловой подложкой спроса). Не отдельный модуль спецификации - лёгкая
// надстройка над уже посчитанными М1-М5 для UI-списка кандидатов. Полный
// портфельный выбор (module 8, CELF) - после 24.09, см. README/journal.md.
//
// Специально не использует equipment.js/economics.js (перебор конфигураций,
// 2-17с на кандидата) - список должен наполняться быстро, кандидат за
// кандидатом, без ожидания. Детальный паспорт с экономикой - по клику на
// конкретную строку, как и раньше.
import { haversineKm } from './choice.js';
import { freeCenterCapacityKW, availablePowerKW } from './grid.js';
import { SEGMENTS } from './demand.js';

const TRAFFIC_RADIUS_KM = 2;
const COMPETITION_RADIUS_KM = 1.5;

function nearestByDistance(lat, lon, points) {
  let best = null;
  let bestD = Infinity;
  for (const p of points) {
    const d = haversineKm(lat, lon, p.lat, p.lon);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

// Считает "сырые" метрики одного кандидата. Быстро: ближайший центр/ячейка
// (перебор ~50/~2600 точек), сумма спроса в радиусе, число станций рядом -
// без локального равновесия, без перебора оборудования.
export function scoreCandidateRaw({ candidate, cells, stations, centers, params, demand }) {
  const center = nearestByDistance(candidate.lat, candidate.lon, centers);
  const centerFreeKW = freeCenterCapacityKW({ center, portfolioLoadKW: 0, params });
  const pAvailKW = availablePowerKW({ RqFreeKW: centerFreeKW, stayInClassA: false });
  const powerScore = Math.max(0, Math.min(100, (pAvailKW / 300) * 100)); // 300 кВт = потолок каталога (DC300-4)

  let trafficRaw = 0;
  for (let i = 0; i < cells.length; i++) {
    if (haversineKm(candidate.lat, candidate.lon, cells[i].lat, cells[i].lon) > TRAFFIC_RADIUS_KM) continue;
    for (const s of SEGMENTS) {
      const arr = demand[s];
      const base = i * 24;
      for (let h = 0; h < 24; h++) trafficRaw += arr[base + h];
    }
  }

  let nearbyCount = 0;
  for (const st of stations) {
    if (haversineKm(candidate.lat, candidate.lon, st.lat, st.lon) <= COMPETITION_RADIUS_KM) nearbyCount++;
  }
  const competitionScore = Math.max(0, 100 - nearbyCount * 8); // -8 баллов за каждую станцию в 1.5 км

  const cell = nearestByDistance(candidate.lat, candidate.lon, cells);

  return {
    powerScore,
    pAvailKW,
    centerFreeKW,
    trafficRaw,
    nearbyCount,
    competitionScore,
    district: cell?.district ?? '—',
    centerId: center?.id ?? '—',
  };
}

// Трафик нормализуется относительно максимума В ТЕКУЩЕМ СПИСКЕ (не
// абсолютная шкала) - осмысленно сравнивать кандидатов друг с другом,
// пересчитывается при каждом добавлении/удалении строки.
export function normalizeAndScore(items) {
  const maxTraffic = Math.max(...items.map((i) => i.trafficRaw), 1e-9);
  return items.map((i) => {
    const trafficScore = Math.max(0, Math.min(100, (i.trafficRaw / maxTraffic) * 100));
    const composite = (i.powerScore + trafficScore + i.competitionScore) / 3;
    return { ...i, trafficScore, composite };
  });
}
