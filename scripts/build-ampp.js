// Парковки АМПП - места, где возможна программа АМПП (РСЗС 29.10.2026: по
// программе АМПП подключение к сети выполняет сетевая организация за свой
// счёт, инвестор платит только станцию). Источник - открытые данные
// data.mos.ru, выгрузка с российского IP 29.10.2026:
//   набор 623 «Платные парковки на улично-дорожной сети» (20.01.2026),
//   набор 1681 «Платные плоскостные парковки» (17.07.2026),
//   набор 622 «Перехватывающие парковки».
// Сохраняется только центр парковки, число мест и номер зоны:
// data/ampp.json {points: [[lat, lon, мест, номер], ...]}.
//   node scripts/build-ampp.js
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'scripts', 'data-sources');
const readZip = (file, enc) => JSON.parse(new TextDecoder(enc).decode(execSync(`unzip -p "${join(SRC, file)}"`, { maxBuffer: 1 << 28 })));

const street = readZip('mos-paid-parking-623.zip', 'windows-1251');
const plane = readZip('mos-parking-1681.zip', 'utf-8');
const intercept = readZip('mos-intercept-parking-622.zip', 'utf-8');
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const points = [];
for (const p of street) {
  const c = p.geodata_center?.coordinates;
  if (c) points.push([r6(c[1]), r6(c[0]), p.CarCapacity ?? 0, String(p.ParkingZoneNumber ?? '')]);
}
// центр плоскостной парковки - среднее вершин полигона, если центра нет
const centroid = (g) => {
  const ring = g?.type === 'Polygon' ? g.coordinates[0] : g?.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
  if (!ring?.length) return null;
  return [ring.reduce((a, q) => a + q[0], 0) / ring.length, ring.reduce((a, q) => a + q[1], 0) / ring.length];
};
for (const p of plane) {
  const c = p.geodata_center?.coordinates ?? centroid(p.geoData?.[0]);
  if (c) points.push([r6(c[1]), r6(c[0]), p.CountSpaces ?? 0, String(p.PlaceID ?? '')]);
}
for (const p of intercept) {
  const c = p.geodata_center?.coordinates ?? centroid(p.geoData?.[0]);
  if (c) points.push([r6(c[1]), r6(c[0]), p.CarCapacity ?? 0, `перехватывающая · ${p.MetroStation || p.DiameterStation || ''}`.trim()]);
}
writeFileSync(
  join(ROOT, 'data', 'ampp.json'),
  JSON.stringify({
    source: 'data.mos.ru: набор 623 «Платные парковки на улично-дорожной сети» (выгрузка 20.01.2026) набор 1681 «Платные плоскостные парковки» (17.07.2026) и набор 622 «Перехватывающие парковки», скачано 29.10.2026. Парковки АМПП - места, где возможна программа АМПП (подключение за счёт сети).',
    date: '2026-10-29',
    fields: ['lat', 'lon', 'мест', 'номер парковки'],
    points,
  })
);
console.log(`парковок АМПП: улица ${street.length}, плоскостные ${plane.length}, перехватывающие ${intercept.length}, всего точек ${points.length}`);
