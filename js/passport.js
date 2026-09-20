// Паспорт площадки (спецификация, раздел 12.2). renderPassport - быстрая
// часть (М1-М4: спрос, выбор, очередь, равновесие, соседи), готова почти
// мгновенно. renderEquipmentEconomics - медленная часть (М5-М7: подбор
// оборудования, подключение, экономика), заполняется отдельным проходом
// после перебора конфигураций (до 5 секунд, раздел 12.3).
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
    <p class="tbd">Быстрый черновик ниже всегда считает DC60-1. Настоящий вердикт и ω* — в разделе «Вердикт и конфигурация» под таблицей соседей (считается отдельным, более медленным проходом).</p>

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
      <h3>Вердикт и конфигурация (раздел 8.2)</h3>
      <p class="tbd">Считаю варианты оборудования…</p>
    </section>

    <section id="passport-connection-section">
      <h3>Подключение к сети</h3>
      <p class="tbd">Считаю…</p>
    </section>

    <section id="passport-economics-section">
      <h3>Экономика</h3>
      <p class="tbd">Считаю…</p>
    </section>
  `;

  return { neighbors, cannibalizationShare, newDemandShare };
}

// Заполняет секции вердикта/подключения/экономики после того, как модуль 6
// (equipment.js) закончит перебор конфигураций - это медленнее, чем
// базовый М1-М4 паспорт, поэтому рендерится отдельным проходом.
export function renderEquipmentEconomics({ evalResult }) {
  const verdictEl = document.getElementById('passport-verdict-section');
  const connEl = document.getElementById('passport-connection-section');
  const econEl = document.getElementById('passport-economics-section');
  if (!verdictEl || !connEl || !econEl) return;

  const rows = evalResult.evaluated
    .map((e) => {
      const npvLow = e.scenarios ? fmt(e.scenarios.low.NPVrub / 1e6) : '—';
      const npvHigh = e.scenarios ? fmt(e.scenarios.high.NPVrub / 1e6) : '—';
      const acc = fmt(e.minAcc * 100, 0);
      const isStar = evalResult.omegaStar && e.cfg.omega === evalResult.omegaStar.cfg.omega;
      return `<tr style="${isStar ? 'font-weight:bold' : ''}"><td>${e.cfg.omega}${e.cfg.costUnknown ? ' (стоимость c_bal неизвестна)' : ''}</td><td>${e.cls}</td><td>${acc}%</td><td>${npvLow}</td><td>${npvHigh}</td></tr>`;
    })
    .join('');

  verdictEl.innerHTML = `
    <h3>Вердикт и конфигурация (раздел 8.2)</h3>
    <div class="metric-row"><span>Вердикт</span><span>${evalResult.verdict}</span></div>
    <table>
      <thead><tr><th>ω</th><th>Класс</th><th>min Acc (2030, зима, будни)</th><th>NPV_low, М₽</th><th>NPV_high, М₽</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="tbd">Жирным — рекомендуемая ω*. min Acc считается по самому тяжёлому случаю (8.2): будний зимний день 2030.</p>
  `;

  const star = evalResult.omegaStar;
  connEl.innerHTML = `
    <h3>Подключение к сети</h3>
    <div class="metric-row"><span>Центр питания</span><span>${evalResult.center.id}</span></div>
    <div class="metric-row"><span>Свободная мощность ЦП</span><span>${fmt(evalResult.centerFree)} кВт</span></div>
    <div class="metric-row"><span>Предел для модуля 6 (P^avail)</span><span>${fmt(evalResult.PavailKW)} кВт</span></div>
    ${
      star && star.connRange
        ? `
    <div class="metric-row"><span>Класс подключения (${star.cfg.omega})</span><span>${star.cls}</span></div>
    <div class="metric-row"><span>Стоимость присоединения</span><span>${fmt(star.connRange.costLow / 1e6)}–${fmt(star.connRange.costHigh / 1e6)} М₽</span></div>
    <div class="metric-row"><span>Срок до запуска</span><span>${fmt(star.connRange.monthsLow, 0)}–${fmt(star.connRange.monthsHigh, 0)} мес.</span></div>
    ${star.cls === 'А|Б' || star.cls === 'Б' ? '<p class="tbd">Класс Б или неопределён — нужен запрос к сетевой компании: точка, мощность, категория надёжности, ближайшая ТП.</p>' : ''}
    `
        : '<p class="tbd">Нет данных по выбранной конфигурации.</p>'
    }
  `;

  econEl.innerHTML = `
    <h3>Экономика</h3>
    ${
      star && star.scenarios
        ? `
    <div class="metric-row"><span>CAPEX (дёшево/дорого)</span><span>${fmt(star.scenarios.high.CAPEXrub / 1e6)}–${fmt(star.scenarios.low.CAPEXrub / 1e6)} М₽</span></div>
    <div class="metric-row"><span>NPV (10 лет)</span><span>от ${fmt(star.scenarios.low.NPVrub / 1e6)} до ${fmt(star.scenarios.high.NPVrub / 1e6)} М₽</span></div>
    <div class="metric-row"><span>Срок окупаемости (простой)</span><span>${star.scenarios.high.Tpb ? fmt(star.scenarios.high.Tpb, 1) + ' лет' : 'больше 10 лет'}</span></div>
    <div class="metric-row"><span>Срок окупаемости (дисконт.)</span><span>${star.scenarios.high.TpbDisc ? fmt(star.scenarios.high.TpbDisc, 1) + ' лет' : 'больше 10 лет'}</span></div>
    <div class="metric-row"><span>U* (замыкающая формула 9.5)</span><span>${star.breakevenInfo ? fmt(star.breakevenInfo.Ustar * 100, 1) + '%' : '—'}</span></div>
    <p class="tbd">Субсидия выключена по умолчанию (раздел 7.5). NPV_low — дорогая граница присоединения (пессимистично), NPV_high — дешёвая.</p>
    `
        : '<p class="tbd">Экономика не посчитана для ω* (класс В или неизвестна стоимость балансировки).</p>'
    }
  `;
}
