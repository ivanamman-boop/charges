// Т3. Цепь против Erlang-C (спецификация, раздел 13).
// Когда шкаф не ограничивает мощность (P^cap = c*P^post) и K большое,
// цепь должна точно совпадать с классической формулой Erlang-C (M/M/c).
// Проверяем при a = 1 (все посты исправны), K = 200, c' = c.
import { queueChainCore } from '../js/queue.js';

function factorial(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

// Классическая формула Erlang-C. offeredLoad = lambda/mu (Эрланги).
function erlangCWait(offeredLoad, c) {
  const rho = offeredLoad / c;
  if (rho >= 1) return null; // нет решения
  let sum = 0;
  for (let k = 0; k < c; k++) sum += Math.pow(offeredLoad, k) / factorial(k);
  const last = Math.pow(offeredLoad, c) / factorial(c) / (1 - rho);
  return last / (sum + last); // P(wait > 0)
}

function erlangCWaitTime(lambda, mu, c) {
  const offeredLoad = lambda / mu;
  const Pwait = erlangCWait(offeredLoad, c);
  if (Pwait === null) return null;
  return Pwait / (c * mu - lambda);
}

const ratios = [0.5, 1.5, 2.5]; // lambda/mu = a (нагрузка в Эрлангах)
const cValues = [1, 2, 4];
const mu = 1; // без ограничения общности, tau = 1 час
const K = 200;
const T = 10 / 60; // порог для Acc не участвует в сравнении W, но нужен интерфейсу

let allPassed = true;
const rows = [];

for (const c of cValues) {
  for (const a of ratios) {
    const rho = a / c;
    const lambda = a * mu;
    const piBar = 1;
    const Pcap = c * piBar; // шкаф не ограничивает мощность
    const Q = K - c;

    const chain = queueChainCore({ lambda, cPrime: c, cTotal: c, Q, mu, Pcap, piBar, T });
    const wErlang = erlangCWaitTime(lambda, mu, c);

    if (wErlang === null) {
      rows.push({ c, a, rho: rho.toFixed(3), status: 'пропуск (rho >= 1, Erlang-C не определён)' });
      continue;
    }

    const relError = Math.abs(chain.W - wErlang) / wErlang;
    const pass = relError < 0.001; // < 0.1%
    if (!pass) allPassed = false;
    rows.push({
      c,
      a,
      rho: rho.toFixed(3),
      W_chain: chain.W.toFixed(6),
      W_erlangC: wErlang.toFixed(6),
      relError: (relError * 100).toFixed(4) + '%',
      status: pass ? 'OK' : 'FAIL',
    });
  }
}

console.table(rows);
console.log(allPassed ? 'Т3: ПРОЙДЕН' : 'Т3: ПРОВАЛЕН');
if (!allPassed) process.exit(1);
