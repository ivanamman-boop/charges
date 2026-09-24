// Паспорт площадки (спецификация, раздел 12.2). renderPassport - быстрая
// часть (М1-М4: спрос, выбор, очередь, равновесие, соседи), готова почти
// мгновенно. renderEquipment - медленная часть (М5-М6: варианты
// оборудования и подключение), заполняется после перебора конфигураций.
// Экономику сайт не показывает (решение команды 24.09: её считают отдельно
// по выбранной точке) - equipment.js её по-прежнему считает внутри.
import { SEGMENTS } from './demand.js';
import { yearAverage } from './equipment.js';

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

  const hourlyTotals = Array.from({ length: 24 }, (_, h) => hourlySegments.reduce((acc, s) => acc + s.values[h], 0));
  const maxBar = Math.max(1e-6, ...hourlyTotals);
  const barsHtml = hourlyTotals
    .map((total, h) => `<div class="bar" style="height:${(total / maxBar) * 100}%" title="${h}:00 — ${fmt(total, 2)} сессий"></div>`)
    .join('');

  container.innerHTML = `
    <h2>Черновик паспорта площадки</h2>
    <p class="tbd">Черновик ниже — для одного поста DC60-1 в выбранных условиях. Все варианты оборудования и рост до 2030 — в разделе «Оборудование и рост» ниже (считается отдельным проходом).</p>

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

    <section id="passport-verdict-section">
      <h3>Оборудование и рост до 2030</h3>
      <p class="tbd">Считаю варианты оборудования…</p>
    </section>

    <section id="passport-connection-section">
      <h3>Подключение к сети</h3>
      <p class="tbd">Считаю…</p>
    </section>
  `;

  return { neighbors, cannibalizationShare, newDemandShare };
}

// Заполняет секции оборудования и подключения после перебора конфигураций
// (модуль 6, equipment.js) - медленнее базового паспорта, отдельным проходом.
export function renderEquipment({ evalResult }) {
  const verdictEl = document.getElementById('passport-verdict-section');
  const connEl = document.getElementById('passport-connection-section');
  if (!verdictEl || !connEl) return;

  const rec = evalResult.recommended;
  const rows = evalResult.evaluated
    .filter((e) => !e.cfg.isBal)
    .map((e) => {
      const a = yearAverage(e, 2026);
      const b = yearAverage(e, 2030);
      const isRec = rec && e.cfg.omega === rec.cfg.omega;
      const blocked = e.cls === 'В';
      return `<tr class="${isRec ? 'rec' : ''} ${blocked ? 'blocked' : ''}">
        <td>${e.cfg.omega}</td>
        <td>${e.cls}</td>
        <td class="num">${fmt(a.sessions, 1)} → ${fmt(b.sessions, 1)}</td>
        <td class="num">+${fmt(a.gain, 1)} → +${fmt(b.gain, 1)}</td>
        <td class="num">${fmt((a.gain + b.gain) / 2 / e.cfg.posts, 1)}</td>
        <td class="num">${fmt(e.accDayByYear[2026] * 100, 0)}% / ${fmt(e.accDayByYear[2030] * 100, 0)}%</td>
      </tr>`;
    })
    .join('');

  const recA = rec && yearAverage(rec, 2026);
  const recB = rec && yearAverage(rec, 2030);
  verdictEl.innerHTML = `
    <h3>Оборудование и рост до 2030</h3>
    ${
      rec
        ? `<div class="rec-card">
        <div class="rec-title">Рекомендуем ${rec.cfg.omega}</div>
        <div class="rec-sub">${rec.cfg.P_cap_kW} кВт, ${rec.cfg.posts} ${rec.cfg.posts === 1 ? 'пост' : 'поста'} · больше всего новых для сети клиентов на один пост</div>
        <div class="rec-grow"><span>${fmt(recA.sessions, 1)}</span><span class="arrow">→</span><span>${fmt(recB.sessions, 1)}</span><span class="unit">сессий в сутки, 2026 → 2030</span></div>
        <div class="rec-sub">из них новых для сети (не переманенных у соседей): +${fmt(recA.gain, 1)} → +${fmt(recB.gain, 1)}</div>
      </div>`
        : '<p class="tbd">Нет допустимых вариантов: на ближайшем центре питания нет резерва мощности (класс В).</p>'
    }
    <table class="equip-table">
      <thead><tr><th>Вариант</th><th>Класс</th><th>Сессий/сут<br>2026 → 2030</th><th>Новых для сети<br>2026 → 2030</th><th>Новых на пост</th><th>Принимает быстро*<br>2026 / 2030</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="tbd">Средний день года. * Доля приехавших в зимний будний день, которых станция принимает без отказа и ожидания дольше 10 мин. Мощнее станция — больше клиентов она перетягивает, поэтому её очередь тоже растёт: доступность почти не зависит от размера. Класс В — подключение невозможно (нет резерва на центре питания).</p>
  `;

  connEl.innerHTML = `
    <h3>Подключение к сети</h3>
    <div class="metric-row"><span>Центр питания</span><span>${evalResult.center.id}${evalResult.center.name ? ` «${evalResult.center.name}»` : ''}</span></div>
    <div class="metric-row"><span>Свободная мощность (оценка)</span><span>${fmt(evalResult.centerFree / 1000, 1)} МВт</span></div>
    ${
      rec && rec.connRange
        ? `<div class="metric-row"><span>Класс подключения (${rec.cfg.omega})</span><span>${rec.cls}</span></div>
    <div class="metric-row"><span>Срок до запуска</span><span>${fmt(rec.connRange.monthsLow, 0)}–${fmt(rec.connRange.monthsHigh, 0)} мес.</span></div>
    ${rec.cls === 'А' ? '<p class="tbd">Класс А: известная трансформаторная подстанция 0.4 кВ ближе 200 м — льготное присоединение.</p>' : '<p class="tbd">Класс Б или не определён: в данных нет ТП 0.4 кВ ближе 200 м — нужен запрос к сетевой компании (точка, мощность, ближайшая ТП).</p>'}`
        : ''
    }
  `;
}
