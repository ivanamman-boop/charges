// Опорные равновесия сети без кандидата (спецификация, раздел 12.3):
// 2 года x 2 сезона x 2 типа дня для базового сценария, посчитанные один раз
// офлайн тем же кодом, что будет крутиться в Web Worker. Браузер в понедельник
// сможет либо взять готовый JSON, либо пересчитать в Worker при загрузке.
//
// Сценарии, отличные от базового (нужны для оставшихся 8 из 16 комбинаций
// раздела 12.3), добавим, когда в интерфейсе появится выбор сценария (пн/вт).
//
// Запуск: node scripts/compute-reference-equilibria.js

import { readFileSync, writeFileSync } from 'node:fs';
import { buildNetworkContext, equilibrium, dailySessions } from '../js/equilibrium.js';

const DATA_DIR = new URL('../data/', import.meta.url);
const cells = JSON.parse(readFileSync(new URL('cells.json', DATA_DIR))).cells;
const stationsAll = JSON.parse(readFileSync(new URL('stations.json', DATA_DIR))).stations;
const params = JSON.parse(readFileSync(new URL('params.json', DATA_DIR)));

const YEARS = [2026, 2030];
const SEASONS = ['winter', 'summer'];
const DAY_TYPES = ['weekday', 'weekend'];
const SCENARIO = 'base';

const combos = [];
for (const year of YEARS) {
  // сеть года y: действуют все станции с year_open <= y (3.1)
  const stations = stationsAll.filter((s) => s.year_open <= year);
  const context = buildNetworkContext({ cells, stations, params });

  for (const season of SEASONS) {
    for (const dayType of DAY_TYPES) {
      const t0 = Date.now();
      const result = equilibrium({ cells, stations, params, year, scenario: SCENARIO, dayType, season, context });
      const S = dailySessions(result.qh.lambdaSrv, stations.length);
      const ms = Date.now() - t0;

      const lambdaOutTotal = Object.values(result.lam.out).reduce(
        (acc, arr) => acc + Array.from(arr).reduce((a, b) => a + b, 0),
        0
      );

      console.log(
        `${year} ${season} ${dayType}: it=${result.it} converged=${result.converged} ${ms}ms, mean S=${(Array.from(S).reduce((a, b) => a + b, 0) / S.length).toFixed(2)}`
      );

      combos.push({
        year,
        season,
        dayType,
        scenario: SCENARIO,
        iterations: result.it,
        converged: result.converged,
        stations: stations.map((s, j) => ({
          id: s.id,
          S: Number(S[j].toFixed(4)),
          W: Array.from({ length: 24 }, (_, h) => Number(result.W[j * 24 + h].toFixed(6))),
          U: Array.from({ length: 24 }, (_, h) => Number(result.qh.U[j * 24 + h].toFixed(4))),
          Acc: Array.from({ length: 24 }, (_, h) => Number(result.qh.Acc[j * 24 + h].toFixed(4))),
        })),
        lambda_out_total: Number(lambdaOutTotal.toFixed(2)),
      });
    }
  }
}

writeFileSync(
  new URL('reference-equilibria.json', DATA_DIR),
  JSON.stringify(
    {
      source: 'scripts/compute-reference-equilibria.js, посчитано в Node тем же кодом, что и Worker',
      date: '2026-09-20',
      note: 'Только сценарий base и сеть без кандидата (8 из 16 комбинаций раздела 12.3). Остальные сценарии — когда появится выбор в интерфейсе.',
      combos,
    },
    null,
    1
  )
);
console.log('data/reference-equilibria.json записан,', combos.length, 'комбинаций');
