// Паспорт площадки (спецификация, раздел 12.2). renderPassport - быстрая
// часть (М1-М4: спрос, выбор, очередь, равновесие, соседи), готова почти
// мгновенно. renderEquipment - медленная часть (М5-М6: варианты
// оборудования и подключение), заполняется после перебора конфигураций.
// Экономику сайт не показывает (решение команды 24.09: её считают отдельно
// по выбранной точке) - equipment.js её по-прежнему считает внутри.
import { SEGMENTS } from './demand.js';
import { yearAverage, newClientsPerMln } from './equipment.js';

const SEGMENT_LABEL = { P0: 'P0 (частник, дом. зарядка)', P1: 'P1 (частник, без дома)', T: 'Такси', C: 'Корпоративный' };

function fmt(x, digits = 2) {
  return Number.isFinite(x) ? x.toFixed(digits) : '—';
}

export function renderPassport({ container, local, baselineS, candidate, stations, district = null, hour = 12, conditions = '' }) {
  const idx = local.candidateLocalIdx;

  // Суточный профиль обслуженных сессий по часам + загрузка/ожидание/доступность.
  const hourlyTotals = Array.from({ length: 24 }, (_, h) => SEGMENTS.reduce((acc, s) => acc + local.combined.bySegment[s][idx * 24 + h] * (1 - local.qh.L[idx * 24 + h]), 0));
  const Uh = Array.from({ length: 24 }, (_, h) => local.qh.U[idx * 24 + h]);
  const Wh = Array.from({ length: 24 }, (_, h) => local.qh.W[idx * 24 + h]);
  const Acch = Array.from({ length: 24 }, (_, h) => local.qh.Acc[idx * 24 + h]);
  let worstHour = 0;
  for (let h = 0; h < 24; h++) if (Acch[h] < Acch[worstHour]) worstHour = h;
  let peakHour = 0;
  for (let h = 0; h < 24; h++) if (hourlyTotals[h] > hourlyTotals[peakHour]) peakHour = h;

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
    if (Math.abs(deltaS) >= 0.05) neighbors.push({ globalJ, station: stations[globalJ], S0: baselineS[globalJ], deltaS });
  });
  neighbors.sort((a, b) => a.deltaS - b.deltaS);

  const cannibalization = neighbors.filter((n) => n.deltaS < 0).reduce((acc, n) => acc - n.deltaS, 0);
  const cannibalizationShare = Snew > 0 ? cannibalization / Snew : 0;
  const newDemand = -local.deltaLambdaOut - local.deltaLambdaLost;
  const newDemandShare = Snew > 0 ? newDemand / Snew : 0;
  const ownLoss = neighbors.filter((n) => n.station.operator === candidate.operator && n.deltaS < 0).reduce((acc, n) => acc - n.deltaS, 0);

  const maxBar = Math.max(1e-6, ...hourlyTotals);
  const barsHtml = hourlyTotals
    .map((total, h) => `<div class="bar ${h === hour ? 'bar-now' : ''} ${h === peakHour ? 'bar-peak' : ''}" style="height:${Math.max(2, (total / maxBar) * 100)}%" title="${h}:00: ${fmt(total, 2)} машин в час"></div>`)
    .join('');

  const losers = neighbors.filter((n) => n.deltaS < 0);
  const maxLoss = Math.max(1e-6, ...losers.map((n) => -n.deltaS));
  const neighborRows = (list) =>
    list
      .map(
        (n) => `<div class="nb-row"><span class="nb-name">${escapeHtml(stationLabel(n.station))}<small>сейчас ${fmt(n.S0, 1)} машин в сутки</small></span><span class="nb-bar"><i style="width:${(-n.deltaS / maxLoss) * 100}%"></i></span><span class="nb-val">−${fmt(-n.deltaS, 2)}</span></div>`
      )
      .join('');

  container.innerHTML = `
    <div class="pp-head">
      <div class="pp-kicker">Прогноз для точки</div>
      <div class="pp-where">${district ? `${escapeHtml(district)} · ` : ''}${candidate.lat.toFixed(4)}, ${candidate.lon.toFixed(4)}</div>
      <div class="pp-cond">${escapeHtml(conditions)}</div>
    </div>

    <section id="passport-verdict-section">
      <h3>Какую станцию здесь ставить</h3>
      <div class="skeleton"></div>
    </section>

    <section>
      <h3>Если поставить простой пост 60 кВт</h3>
      <p class="pp-note">Все цифры ниже посчитаны для одного поста 60 кВт в выбранный день, сезон и год. Так разные места можно сравнивать при одинаковом оборудовании. Сколько машин получит рекомендованная станция, написано в блоке выше.</p>
      <div class="tiles">
        <div class="tile"><div class="tile-value">${fmt(Snew, 1)}</div><div class="tile-label">машин в сутки</div></div>
        <div class="tile"><div class="tile-value">${fmt(Math.max(0, newDemandShare) * 100, 0)}%</div><div class="tile-label">из них новые клиенты</div></div>
        <div class="tile"><div class="tile-value">${fmt(shareLost * 100, 0)}%</div><div class="tile-label">уезжают, не дождавшись очереди</div></div>
        <div class="tile"><div class="tile-value">${fmt(Wh[peakHour] * 60, 0)} мин</div><div class="tile-label">ожидание в самый загруженный час</div></div>
      </div>
    </section>

    <section>
      <h3>Когда приезжают машины</h3>
      <div class="bar-chart">${barsHtml}</div>
      <div class="bar-axis"><span>0:00</span><span>6:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>
      <p class="pp-note">Больше всего машин в ${peakHour}:00. Выделен выбранный час, ${hour}:00: пост занят ${fmt(Uh[hour] * 100, 0)}% времени, ожидание ${fmt(Wh[hour] * 60, 0)} мин.</p>
    </section>

    <section>
      <h3>У кого станция заберёт клиентов</h3>
      <p class="pp-sentence">Из ${fmt(Snew, 1)} машин в сутки <b>${fmt(Math.max(0, newDemand), 1)}</b> будут новыми клиентами. Ещё <b>${fmt(cannibalization, 1)}</b> перейдут с ${losers.length} ${plural(losers.length, 'соседней станции', 'соседних станций', 'соседних станций')}.</p>
      ${losers.length ? `<div class="nb-list">${neighborRows(losers.slice(0, 6))}</div>` : '<p class="pp-note">Рядом нет станций, у которых новая заметно заберёт клиентов.</p>'}
      ${losers.length > 6 ? `<details class="nb-more"><summary>ещё ${losers.length - 6}</summary><div class="nb-list">${neighborRows(losers.slice(6))}</div></details>` : ''}
    </section>

    <section id="passport-connection-section">
      <h3>Подключение к электросети</h3>
      <div class="skeleton short"></div>
    </section>

    <details class="tech">
      <summary>Технические детали</summary>
      <div class="metric-row"><span>Обслужено сессий в сутки, S_new</span><span>${fmt(Snew)}</span></div>
      <div class="metric-row"><span>Доля отказов за сутки, p_K</span><span>${fmt(shareLost * 100, 1)}%</span></div>
      <div class="metric-row"><span>Худший час по доступности, Acc</span><span>${worstHour}:00 — ${fmt(Acch[worstHour] * 100, 1)}%</span></div>
      <div class="metric-row"><span>Каннибализация</span><span>${fmt(cannibalizationShare * 100, 1)}%</span></div>
      <div class="metric-row"><span>Потери станций того же оператора</span><span>${fmt(ownLoss, 2)} в сутки</span></div>
      <div class="metric-row"><span>Изменение «уехали без зарядки», ΔΛ_out</span><span>${fmt(local.deltaLambdaOut, 2)}</span></div>
      <div class="metric-row"><span>Изменение «ушли из-за очереди», ΔΛ_lost</span><span>${fmt(local.deltaLambdaLost, 2)}</span></div>
    </details>
  `;

  return { neighbors, cannibalizationShare, newDemandShare };
}

function stationLabel(st) {
  if (st.status === 'planned') return 'Плановая станция города';
  return !st.operator || st.operator === 'независимый' ? 'Станция без сети' : st.operator;
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function escapeHtml(t) {
  return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
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
        <td class="num">${e.scenarios ? fmt(newClientsPerMln(e), 2) : '—'}</td>
        <td class="num">${fmt(e.accDayByYear[2026] * 100, 0)}% / ${fmt(e.accDayByYear[2030] * 100, 0)}%</td>
      </tr>`;
    })
    .join('');

  const recA = rec && yearAverage(rec, 2026);
  const recB = rec && yearAverage(rec, 2030);
  verdictEl.innerHTML = `
    <h3>Какую станцию здесь ставить</h3>
    ${
      rec
        ? `<div class="rec-card">
        <div class="rec-title">${rec.cfg.omega}: ${rec.cfg.P_cap_kW} кВт, ${rec.cfg.posts} ${rec.cfg.posts === 1 ? 'пост' : 'поста'}</div>
        <div class="rec-sub">Из всех вариантов этот даёт больше всего новых клиентов на каждый вложенный миллион рублей (станция и подключение).</div>
        <div class="rec-grow"><span>${fmt(recA.sessions, 1)}</span><span class="arrow">→</span><span>${fmt(recB.sessions, 1)}</span><span class="unit">машин в сутки<br>в 2026 и 2030</span></div>
        <div class="rec-sub">Из них новых клиентов: <b>${fmt(recA.gain, 1)} в 2026 году, ${fmt(recB.gain, 1)} в 2030 году</b>. Остальные перейдут с соседних станций.</div>
      </div>`
        : '<p class="pp-note">Здесь станцию поставить нельзя: у ближайшей подстанции нет свободной мощности (класс В).</p>'
    }
    <details class="equip-details"><summary>Все варианты оборудования</summary><table class="equip-table">
      <thead><tr><th>Станция</th><th>Класс</th><th>Машин в сутки<br>2026 → 2030</th><th>Из них новых<br>2026 → 2030</th><th>Новых на 1 млн ₽</th><th>Принимает быстро*<br>2026 / 2030</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="pp-note">Средний день года. * Доля водителей, которых станция в зимний будний день принимает без отказа и без ожидания дольше 10 минут. Более мощная станция привлекает больше машин, поэтому очередь у неё тоже растёт, и эта доля почти не зависит от мощности. Класс В: у подстанции нет свободной мощности, подключить нельзя.</p>
    </details>
  `;

  connEl.innerHTML = `
    <h3>Подключение к электросети</h3>
    <div class="metric-row"><span>Питающая подстанция</span><span>${evalResult.center.id}${evalResult.center.name ? ` «${evalResult.center.name}»` : ''}</span></div>
    <div class="metric-row"><span>Свободная мощность (оценка)</span><span>${fmt(evalResult.centerFree / 1000, 1)} МВт</span></div>
    ${
      rec && rec.connRange
        ? `<div class="metric-row"><span>Класс подключения</span><span>${rec.cls}</span></div>
    <div class="metric-row"><span>Стоимость подключения (оценка)</span><span>${fmt(rec.connRange.costLow / 1e6, 1)}–${fmt(rec.connRange.costHigh / 1e6, 1)} млн ₽</span></div>
    <div class="metric-row"><span>Вложения: станция, подключение, площадка</span><span>до ${fmt(rec.scenarios.low.CAPEXrub / 1e6, 1)} млн ₽</span></div>
    <div class="metric-row"><span>Срок до запуска</span><span>${fmt(rec.connRange.monthsLow, 0)}–${fmt(rec.connRange.monthsHigh, 0)} мес.</span></div>
    ${rec.cls === 'А' ? '<p class="pp-note">Класс А: трансформаторная подстанция 0,4 кВ ближе 200 м, подключение дешёвое.</p>' : '<p class="pp-note">Класс Б: в данных нет трансформаторной подстанции ближе 200 м. Точную цену и срок нужно запросить у сетевой компании.</p>'}`
        : ''
    }
  `;
}
