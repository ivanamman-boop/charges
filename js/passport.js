// Черновик паспорта площадки (спецификация, раздел 12.2). Сегодня доступны
// только части, посчитанные модулями 1-4 (спрос, выбор, очередь, равновесие
// и влияние на соседей). Подключение (М5), оборудование/экономика (М6-М7) —
// добавляются во вторник, здесь показаны как TBD.
import { SEGMENTS } from './demand.js';

const SEGMENT_LABEL = { P0: 'P0 (частник, дом. зарядка)', P1: 'P1 (частник, без дома)', T: 'Такси', C: 'Корпоративный' };

function fmt(x, digits = 2) {
  return Number.isFinite(x) ? x.toFixed(digits) : '—';
}

export function renderPassport({ container, local, baselineS, candidate, stations }) {
  const idx = local.candidateLocalIdx;
  const localStations = local.localStations;

  // Суточный профиль λ^srv по сегментам + U(h) для кандидата.
  const hourlySegments = SEGMENTS.map((s) => {
    const arr = new Array(24);
    for (let h = 0; h < 24; h++) {
      const total = local.combined.bySegment[s][idx * 24 + h];
      const L = local.qh.L[idx * 24 + h];
      arr[h] = total * (1 - L);
    }
    return { segment: s, values: arr };
  });
  const Uh = Array.from({ length: 24 }, (_, h) => local.qh.U[idx * 24 + h]);
  const Wh = Array.from({ length: 24 }, (_, h) => local.qh.W[idx * 24 + h]);
  const Acch = Array.from({ length: 24 }, (_, h) => local.qh.Acc[idx * 24 + h]);

  let worstHour = 0;
  let worstAcc = 1;
  for (let h = 0; h < 24; h++) {
    if (Acch[h] < worstAcc) {
      worstAcc = Acch[h];
      worstHour = h;
    }
  }

  const Snew = local.S_local[idx];
  let totalArrival = 0;
  let totalSrv = 0;
  for (let h = 0; h < 24; h++) {
    for (const s of SEGMENTS) totalArrival += local.combined.bySegment[s][idx * 24 + h];
    totalSrv += local.qh.lambdaSrv[idx * 24 + h];
  }
  const shareLost = totalArrival > 0 ? (totalArrival - totalSrv) / totalArrival : 0;

  // Соседи с |ΔS| >= 0.05 сессии/сутки (6.3).
  const neighbors = [];
  local.affectedStationIdx.forEach((globalJ, localJ) => {
    const deltaS = local.S_local[localJ] - baselineS[globalJ];
    if (Math.abs(deltaS) >= 0.05) {
      neighbors.push({ globalJ, station: stations[globalJ], S0: baselineS[globalJ], deltaS });
    }
  });
  neighbors.sort((a, b) => a.deltaS - b.deltaS);

  const cannibalization = neighbors.filter((n) => n.deltaS < 0).reduce((acc, n) => acc - n.deltaS, 0);
  const cannibalizationShare = Snew > 0 ? cannibalization / Snew : 0;
  const newDemandShare = Snew > 0 ? (-local.deltaLambdaOut - local.deltaLambdaLost) / Snew : 0;

  const own = neighbors.filter((n) => n.station.operator === candidate.operator);
  const foreign = neighbors.filter((n) => n.station.operator !== candidate.operator);
  const ownLoss = own.filter((n) => n.deltaS < 0).reduce((acc, n) => acc - n.deltaS, 0);
  const foreignLoss = foreign.filter((n) => n.deltaS < 0).reduce((acc, n) => acc - n.deltaS, 0);

  const maxBar = Math.max(1e-6, ...hourlySegments.flatMap((s) => s.values));
  const barsHtml = Array.from({ length: 24 }, (_, h) => {
    const parts = hourlySegments.map((s) => s.values[h]);
    const total = parts.reduce((a, b) => a + b, 0);
    return `<div class="bar" style="height:${(total / maxBar) * 100}%" title="${h}:00 — ${fmt(total, 2)} сессий"></div>`;
  }).join('');

  container.innerHTML = `
    <h2>Черновик паспорта площадки</h2>
    <p class="tbd">Вердикт и рекомендуемая конфигурация — модуль 6, вторник. Кандидат ниже — заглушка DC60-1.</p>

    <section>
      <h3>Кандидат</h3>
      <div class="metric-row"><span>Координаты</span><span>${candidate.lat.toFixed(4)}, ${candidate.lon.toFixed(4)}</span></div>
      <div class="metric-row"><span>Конфигурация</span><span>DC60-1 (60 кВт, 1 пост) — заглушка</span></div>
      <div class="metric-row"><span>S_new (сессий/сутки)</span><span>${fmt(Snew)}</span></div>
      <div class="metric-row"><span>Доля уехавших (p_K, за сутки)</span><span>${fmt(shareLost * 100, 1)}%</span></div>
      <div class="metric-row"><span>Худший час по Acc</span><span>${worstHour}:00 — Acc=${fmt(Acch[worstHour] * 100, 1)}%, W=${fmt(Wh[worstHour] * 60, 1)} мин, U=${fmt(Uh[worstHour] * 100, 1)}%</span></div>
    </section>

    <section>
      <h3>Суточный профиль λ^srv (сессий/час)</h3>
      <div class="bar-chart">${barsHtml}</div>
      <div class="metric-row" style="font-size:0.7rem;color:#999"><span>0:00</span><span>12:00</span><span>23:00</span></div>
    </section>

    <section>
      <h3>Влияние на соседей (раздел 6.3)</h3>
      <div class="metric-row"><span>Доля каннибализации</span><span>${fmt(cannibalizationShare * 100, 1)}%</span></div>
      <div class="metric-row"><span>Доля нового спроса</span><span>${fmt(newDemandShare * 100, 1)}%</span></div>
      <div class="metric-row"><span>Потери "своих" (тот же оператор)</span><span>${fmt(ownLoss, 2)} сессий/сутки</span></div>
      <div class="metric-row"><span>Потери "чужих"</span><span>${fmt(foreignLoss, 2)} сессий/сутки</span></div>
      <table>
        <thead><tr><th>Станция</th><th>Оператор</th><th>S⁰</th><th>ΔS</th></tr></thead>
        <tbody>
          ${neighbors
            .slice(0, 15)
            .map(
              (n) =>
                `<tr><td>${n.station.id}</td><td>${n.station.operator}</td><td>${fmt(n.S0)}</td><td style="color:${n.deltaS < 0 ? '#c0392b' : '#2980b9'}">${n.deltaS > 0 ? '+' : ''}${fmt(n.deltaS)}</td></tr>`
            )
            .join('')}
        </tbody>
      </table>
      ${neighbors.length > 15 ? `<p class="tbd">и ещё ${neighbors.length - 15}…</p>` : ''}
    </section>

    <section>
      <h3>Подключение к сети</h3>
      <p class="tbd">Модуль 5 — вторник (класс подключения, R'_q, диапазон стоимости и срока).</p>
    </section>

    <section>
      <h3>Экономика</h3>
      <p class="tbd">Модуль 7 — вторник (CAPEX, NPV, срок окупаемости, U*).</p>
    </section>
  `;

  return { neighbors, cannibalizationShare, newDemandShare };
}
