// Модуль 3. Очередь и загрузка (спецификация, раздел 5).
// Цепь гибели-размножения M/M/c/K с зависящей от состояния скоростью
// обслуживания. Чистые функции, без обращений к DOM — запускаются и в Node
// (тесты), и в Web Worker (расчёт).

export function sessionMetrics({ P_post, P_veh, phi, kappaP, e, kappaE, t0 }) {
  const pi = Math.min(P_post, P_veh) * phi * kappaP; // 5.1, средняя мощность за сессию, кВт
  const tau = (e * kappaE) / pi + t0; // 5.1, длительность сессии, ч
  return { pi, tau };
}

// Взвешивание по сегментам внутри часа (5.1, последняя формула).
export function hourlyAverages(segments) {
  // segments: [{ lambda, pi, tau }, ...]
  let lambdaTotal = 0;
  let piNum = 0;
  let tauNum = 0;
  for (const s of segments) {
    lambdaTotal += s.lambda;
    piNum += s.lambda * s.pi;
    tauNum += s.lambda * s.tau;
  }
  if (lambdaTotal === 0) return { lambdaTotal: 0, piBar: 0, tauBar: 0, mu: 0 };
  const piBar = piNum / lambdaTotal;
  const tauBar = tauNum / lambdaTotal;
  return { lambdaTotal, piBar, tauBar, mu: 1 / tauBar };
}

// 5.2. Скорость обслуживания в состоянии n = 1..K.
export function serviceRates({ cPrime, K, mu, Pcap, piBar }) {
  const r = new Float64Array(K + 1); // r[0] не используется
  for (let n = 1; n <= K; n++) {
    const bn = Math.min(n, cPrime);
    if (bn === 0) {
      r[n] = 0;
      continue;
    }
    const eta = Math.min(1, Pcap / (bn * piBar));
    r[n] = bn * mu * eta;
  }
  return r;
}

// 5.3. Стационарное распределение p_n, n = 0..K.
export function stationaryDistribution(lambda, r, K) {
  const p = new Float64Array(K + 1);
  if (lambda === 0) {
    p[0] = 1;
    return p;
  }
  const t = new Float64Array(K + 1);
  t[0] = 1;
  for (let n = 1; n <= K; n++) {
    t[n] = r[n] > 0 ? (t[n - 1] * lambda) / r[n] : 0;
  }
  let sum = 0;
  for (let n = 0; n <= K; n++) sum += t[n];
  for (let n = 0; n <= K; n++) p[n] = t[n] / sum;
  return p;
}

// 5.4. Показатели часа при заданном числе исправных постов c'.
export function chainMetrics({ lambda, p, cPrime, cTotal, K }) {
  const L = p[K];
  const lambdaSrv = lambda * (1 - L);
  let Lq = 0;
  for (let n = cPrime + 1; n <= K; n++) Lq += (n - cPrime) * p[n];
  let U = 0;
  for (let n = 0; n <= K; n++) U += Math.min(n, cPrime) * p[n];
  U = U / cTotal;
  const W = lambdaSrv > 0 ? Lq / lambdaSrv : 0;
  return { L, lambdaSrv, Lq, U, W };
}

// 5.4. Доступность Acc(T) — доля спроса, обслуженного с ожиданием <= T (часы).
export function accessibility({ p, r, cPrime, K, T }) {
  if (cPrime === 0) return 0;
  const rc = r[cPrime];
  let acc = 0;
  for (let n = 0; n <= cPrime - 1; n++) acc += p[n];
  for (let n = cPrime; n <= K - 1; n++) {
    const mMax = n - cPrime;
    let poissonCdf = 0;
    let term = Math.exp(-rc * T);
    for (let m = 0; m <= mMax; m++) {
      poissonCdf += term;
      term *= (rc * T) / (m + 1);
    }
    acc += p[n] * (1 - poissonCdf);
  }
  return acc;
}

// Ядро цепи при фиксированном числе исправных постов c' (без усреднения по
// исправности). Используется напрямую в тесте Т3 (там a = 1, c' = c).
export function queueChainCore({ lambda, cPrime, cTotal, Q, mu, Pcap, piBar, T }) {
  const K = cPrime + Q;
  const r = serviceRates({ cPrime, K, mu, Pcap, piBar });
  const p = stationaryDistribution(lambda, r, K);
  const metrics = chainMetrics({ lambda, p, cPrime, cTotal, K });
  const Acc = accessibility({ p, r, cPrime, K, T });
  return { ...metrics, Acc, p, r, K };
}

function comb(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return result;
}

function binomialWeight(c, cPrime, a) {
  return comb(c, cPrime) * Math.pow(a, cPrime) * Math.pow(1 - a, c - cPrime);
}

// 5.5. Полный расчёт часа с усреднением по исправности постов c' ~ Bin(c, a).
// a = a_tech * (1 - b_ICE).
export function queueHour({ lambda, c, Q, a, mu, Pcap, piBar, T }) {
  let lambdaSrv = 0;
  let Lq = 0;
  let U = 0;
  let Acc = 0;
  let L = 0;

  for (let cPrime = 0; cPrime <= c; cPrime++) {
    const w = binomialWeight(c, cPrime, a);
    if (w === 0) continue;

    if (cPrime === 0) {
      // При c' = 0 уезжают все (5.5): lambda_srv = 0, Lq = 0, U = 0, Acc = 0, L = 1.
      L += w * 1;
      continue;
    }

    const core = queueChainCore({ lambda, cPrime, cTotal: c, Q, mu, Pcap, piBar, T });
    lambdaSrv += w * core.lambdaSrv;
    Lq += w * core.Lq;
    U += w * core.U;
    Acc += w * core.Acc;
    L += w * core.L;
  }

  // W считается после усреднения, а не усредняется напрямую (5.5).
  const W = lambdaSrv > 0 ? Lq / lambdaSrv : 0;
  return { lambdaSrv, Lq, U, Acc, W, L };
}
