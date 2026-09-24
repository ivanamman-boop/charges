// Т10. Монотонность (спецификация, раздел 13): больше радиус поездки ->
// шире зона станций; больше поток -> ожидание не падает; меньше резерв
// мощности -> рекомендуемое оборудование не мощнее. Та же функция, что и в
// браузере (js/tests.js), здесь - с полным каталогом оборудования.
import { readFileSync } from 'node:fs';
import { testT10 } from '../js/tests.js';

const cells = JSON.parse(readFileSync(new URL('../data/cells.json', import.meta.url))).cells;
const stations = JSON.parse(readFileSync(new URL('../data/stations.json', import.meta.url))).stations;
const params = JSON.parse(readFileSync(new URL('../data/params.json', import.meta.url)));
params.equilibrium = { ...params.equilibrium, convergence_threshold_hours: params.equilibrium.convergence_threshold_hours_precise };

const r = testT10({ cells, stations, params, fast: false });
console.log(r.detail.split('; ').join('\n'));
console.log(r.pass ? 'Т10: ПРОЙДЕН' : 'Т10: ПРОВАЛЕН');
process.exit(r.pass ? 0 : 1);
