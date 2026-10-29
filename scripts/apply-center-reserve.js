// После обновления резерва центров питания (scripts/merge-rossetimr-centers.py)
// зонам и площадкам, у чьего центра реальный резерв меньше мощности станции,
// ставится класс В (нет свободной мощности, модуль 5) без полного пересчёта
// зон: спрос от резерва центра не зависит, меняется только класс и мощность.
// Обратное (оценка была 0, а резерв есть) здесь не делается - для этого
// нужен npm run compute:zones.
//   node scripts/apply-center-reserve.js
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
const centers = new Map(read('centers.json').centers.map((c) => [c.id, c]));
const zonesPath = join(ROOT, 'data', 'zones.json');
const zones = read('zones.json');
const params = read('params.json');
const cosPhi = params.M5_grid.cos_phi.value;
const P_KW = 150;
let nz = 0;
let ns = 0;
const fix = (by) => {
  let changed = false;
  for (const b of Object.values(by || {})) {
    const c = centers.get(b.center?.id);
    if (!c?.rossetimr) continue;
    const freeKW = 1000 * c.reserve_MVA * cosPhi;
    b.center.freeMW = Math.round(freeKW / 10) / 100;
    if (freeKW < P_KW && b.cls !== 'В') {
      b.cls = 'В';
      changed = true;
    }
  }
  return changed;
};
for (const z of zones.zones) if (fix(z.by)) nz++;
for (const s of zones.sites) if (fix(s.by)) ns++;
if (!zones.source.includes('apply-center-reserve')) zones.source += ' | 29.10.2026: класс В у зон и площадок на центрах без резерва по раскрытию «Россети Московский регион» (scripts/apply-center-reserve.js)';
writeFileSync(zonesPath, JSON.stringify(zones));
console.log(`класс В: зон ${nz}, площадок ${ns}`);
