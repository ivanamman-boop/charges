// Паспорт площадки (спецификация, раздел 12.2) - документ до заявки на
// техприсоединение. Рисуется целиком из view-model, которую собирает app.js:
// сначала из готового расчёта зон (data/zones.json, мгновенно), затем из
// живого расчёта модулей 1-7 для этой точки (equipment.js + econ-view.js).
// Повторный вызов с обновлённой моделью (МФППиП, сценарий, конец расчёта)
// просто перерисовывает страницу.
import { STATUS, VERDICT } from './econ-view.js';

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const num = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d).replace('.', ','));
const mln = (rub, d = 1) => (rub === null || rub === undefined || !Number.isFinite(rub) ? '—' : `${num(rub / 1e6, d)}`);
const signedMln = (rub) => (Number.isFinite(rub) ? `${rub >= 0 ? '+' : '−'}${num(Math.abs(rub) / 1e6, 1)}` : '—');
const pct = (v, d = 0) => (Number.isFinite(v) ? `${num(v * 100, d)}%` : '—');
const thousands = (rub) => `${Math.round(rub / 1000).toLocaleString('ru-RU')} тыс. ₽`;

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const SCENARIO_BTNS = [
  ['base', '+30% · базовый'],
  ['fast', '+80% · быстрый'],
];

// Загрузка поста по годам: линия прогноза, полоса - разброс между режимами
// дня (выходной лета ... будни зимы), пунктир - пороги окупаемости.
function loadChart(vm) {
  const years = [2026, 2027, 2028, 2029, 2030];
  const U = years.map((y) => vm.U[y]);
  const lo = years.map((y) => vm.Urange[y][0]);
  const hi = years.map((y) => vm.Urange[y][1]);
  const top = Math.max(0.3, ...hi, vm.th.uNpv * 1.25);
  const W = 560;
  const H = 230;
  const pad = { l: 40, r: 70, t: 18, b: 28 };
  const x = (i) => pad.l + (i * (W - pad.l - pad.r)) / (years.length - 1);
  const y = (u) => pad.t + (1 - u / top) * (H - pad.t - pad.b);
  const band = `M${years.map((_, i) => `${x(i)},${y(hi[i])}`).join(' L')} L${years.map((_, i) => `${x(years.length - 1 - i)},${y(lo[years.length - 1 - i])}`).join(' L')} Z`;
  const line = `M${years.map((_, i) => `${x(i)},${y(U[i])}`).join(' L')}`;
  const grid = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6].filter((g) => g <= top + 1e-9);
  const thLine = (u, label, cls) =>
    u <= top ? `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(u)}" y2="${y(u)}" class="th ${cls}"/><text x="${W - pad.r + 6}" y="${y(u) + 4}" class="th-label">${label}</text>` : '';
  return `<svg class="load-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Загрузка поста по годам">
    ${grid.map((g) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(g)}" y2="${y(g)}" class="grid"/><text x="${pad.l - 8}" y="${y(g) + 4}" class="axis" text-anchor="end">${Math.round(g * 100)}%</text>`).join('')}
    <path d="${band}" class="band"/>
    ${thLine(vm.th.uNpv, `${num(vm.th.uNpv * 100, 0)}% с дисконтом`, 'th-npv')}
    ${thLine(vm.th.uPb, `${num(vm.th.uPb * 100, 0)}% за ${vm.th.normYears} лет`, 'th-pb')}
    <path d="${line}" class="line"/>
    ${years
      .map(
        (yr, i) => `<circle cx="${x(i)}" cy="${y(U[i])}" r="${yr === vm.year ? 6 : 4}" class="pt ${yr === vm.year ? 'pt-now' : ''}"/>
      <text x="${x(i)}" y="${y(U[i]) - 12}" class="pt-label" text-anchor="middle">${num(U[i] * 100, 0)}%</text>
      <text x="${x(i)}" y="${H - 6}" class="axis" text-anchor="middle">${yr}</text>`
      )
      .join('')}
  </svg>`;
}

// Окупаемость диапазоном: дешёвая — дорогая граница цены подключения.
function paybackText(econ) {
  const one = (v) => (v === null || v === undefined ? '> 10' : num(v, 1));
  const r = econ.paybackRange;
  if (!r || one(r[0]) === one(r[1])) return one(econ.payback);
  return `${one(r[0])}–${one(r[1])}`;
}

function yearTable(vm) {
  if (!vm.yearRows) return '';
  const cols = vm.yearRows;
  const row = (label, f) => `<tr><td>${label}</td>${cols.map((c) => `<td class="num">${f(c)}</td>`).join('')}</tr>`;
  return `<section class="pp-card pp-wide">
    <h3>Прогноз по годам</h3>
    <table class="data-table year-table"><thead><tr><th></th>${cols.map((c) => `<th class="num">${c.year}</th>`).join('')}</tr></thead><tbody>
      ${row('Сессий в сутки', (c) => num(c.S, 1))}
      ${row('Загрузка поста', (c) => pct(c.U, 1))}
      ${row('Доля такси', (c) => pct(c.taxi))}
      ${row('Пост свободен, зимний будний день', (c) => pct(c.free))}
      ${row('Новых для города в сутки', (c) => num(Math.max(0, c.gain), 1))}
    </tbody></table>
    <p class="pp-note">Средний день года, ${esc(vm.scenarioLabel)}. Остальные сессии переходят с соседних станций${vm.ownLoss !== null ? `; у станций самой РСЗС точка забирает ${num(vm.ownLoss, 1)} сессии в сутки (${esc(vm.live?.conditions || '')})` : ''}.</p>
  </section>`;
}

// Вердикт по правилу ТЗ (BR-22): строить / запросить ТУ / не строить.
function verdictText(vm) {
  const t = vm.econ.tz;
  const r = vm.econ.paybackRange || [];
  if (t.verdict === 'build') return `NPV при дорогом подключении ${signedMln(vm.econ.npv)} млн ₽, окупаемость ${paybackText(vm.econ)} лет — не дольше норматива ${vm.th.normYears} лет.`;
  if (t.verdict === 'request') return `NPV выше нуля только при дешёвом подключении. Нужны технические условия сети: реальная цена ТП решит вопрос.`;
  return `NPV ниже нуля даже при дешёвом подключении${r[0] === null ? ', за 10 лет не окупается' : ''}.`;
}

function econBlock(vm) {
  const t = vm.econ?.tz;
  if (!t) return '';
  const rng = (a) => `${mln(a[0], 2)}–${mln(a[1], 2)}`;
  const row = (k, v, note = '') => `<div class="metric-row"><span>${k}${note ? `<small class="metric-note">${note}</small>` : ''}</span><span class="mono">${v}</span></div>`;
  const marginTone = t.margin >= 1 ? 'ok' : 'warn';
  return `<section class="pp-card pp-wide">
    <h3>Экономика станции и сети, решение в ${vm.year}</h3>
    <div class="econ-grid">
      <div>
        ${row('Маржа на сессию m̄', `${num(t.mBar, 0)} ₽`, `средняя по водителям станции, ${t.year}; зимой расход ×1,15`)}
        ${row('Сессий в сутки N', num(t.N, 1), `средний день ${t.year}`)}
        ${row('Загрузка поста U', pct(vm.U[t.year], 1), 'ориентир РСЗС 8–10% к концу первого года')}
        ${row('Годовой поток CF (EBITDA)', `${signedMln(t.cfYear)} млн ₽`, `365 × N × m̄ − постоянные ${mln(t.F, 2)} млн`)}
        ${row('Вложения без субсидии', `${rng(t.capexNoSub)} млн ₽`)}
        ${row('Вложения с МФППиП', `${rng(t.capexMfppip)} млн ₽`, 'компенсация 50% платы за ТП, тремя платежами')}
      </div>
      <div>
        ${row('Простая окупаемость', `${paybackText(vm.econ)} лет`, `норматив РСЗС ${vm.th.normYears} лет`)}
        ${row('Дисконтированная окупаемость', t.paybackDisc === null ? '> 10 лет' : `${num(t.paybackDisc, 1)} лет`, 'ставка 18%, дорогое подключение')}
        ${row('NPV станции', `${signedMln(t.npvStation)} млн ₽`, '10 лет, 18%, все сессии станции')}
        ${row('NPV для сети РСЗС', `${signedMln(t.npvNetwork)} млн ₽`, 'без сессий, перешедших со станций самой РСЗС')}
        ${row('Порог безубыточности S*', `${num(t.Sstar, 1)} сессии`, `U* = ${pct(t.Ustar, 1)}; вложения возвращаются с учётом ставки за 10 лет`)}
        <div class="metric-row"><span>Запас прочности N / S*</span><span class="mono tone-${marginTone}">${num(t.margin, 2)}</span></div>
      </div>
    </div>
    <p class="pp-note">${vm.subsidy ? 'Компенсация МФППиП включена.' : 'Без компенсации МФППиП.'} Окупаемость и NPV — помесячный поток с ${vm.year} года, первые месяцы до подключения без выручки. Запас больше 1 — прогноз выше порога безубыточности.</p>
  </section>`;
}

function kpiTile({ label, value, unit = '', sub = '', tone = '' }) {
  return `<div class="pp-kpi"><div class="pp-kpi-top"><span>${label}</span><span class="tag">модель</span></div><div class="pp-kpi-value ${tone}">${value}${unit ? `<small>${unit}</small>` : ''}</div><div class="pp-kpi-sub">${sub}</div></div>`;
}

function robustBlock(vm) {
  if (!vm.robust) return '<div class="skeleton"></div><p class="pp-note">Считается вместе с точным прогнозом…</p>';
  const r = vm.robust;
  const [pMin, pMax] = r.pElRange;
  const scaleLo = Math.min(pMin, r.pElZero ?? pMin) * 0.8;
  const scaleHi = Math.max(pMax, r.pElZero ?? pMax) * 1.1;
  const pos = (v) => `${(((v - scaleLo) / (scaleHi - scaleLo)) * 100).toFixed(1)}%`;
  const npvPositive = vm.econ.npv > 0;
  let verdict;
  let tone;
  if (npvPositive && (r.pElZero === null || r.pElZero > pMax)) {
    verdict = `Вывод держится даже при самой дорогой электроэнергии из диапазона (${num(pMax, 0)} ₽ за кВт·ч).${r.demandZeroPct !== null ? ` Спрос может оказаться ниже прогноза на ${num(-r.demandZeroPct * 100, 0)}%, и NPV останется выше нуля.` : ''}`;
    tone = 'ok';
  } else if (npvPositive) {
    verdict = `Вывод хрупкий. Если электроэнергия подорожает до ${num(r.pElZero, 1)} ₽ за кВт·ч (${r.pElZeroPct >= 0 ? '+' : '−'}${num(Math.abs(r.pElZeroPct) * 100, 0)}%), станция перестанет окупать капитал.`;
    tone = 'warn';
  } else {
    verdict =
      r.pElZero !== null && r.pElZero > 0
        ? `NPV ниже нуля. Станция окупит капитал при электроэнергии дешевле ${num(r.pElZero, 1)} ₽ за кВт·ч${r.demandZeroPct !== null ? ` или при спросе выше прогноза на ${num(r.demandZeroPct * 100, 0)}%` : ''}.`
        : `NPV ниже нуля при любой цене электроэнергии${r.demandZeroPct !== null ? `; нужен спрос выше прогноза на ${num(r.demandZeroPct * 100, 0)}%` : ''}.`;
    tone = 'warn';
  }
  return `
    <div class="robust-row">
      <div class="robust-label">Цена электроэнергии ${num(pMin, 0)}–${num(pMax, 0)} ₽ за кВт·ч, в расчёте ${num(r.pElBase, 0)} ₽</div>
      <div class="robust-scale"><span class="rs-range" style="left:${pos(pMin)};width:calc(${pos(pMax)} - ${pos(pMin)})"></span><span class="rs-base" style="left:${pos(r.pElBase)}"></span>${r.pElZero !== null ? `<span class="rs-zero" style="left:${pos(r.pElZero)}"></span>` : ''}</div>
      <div class="robust-ends"><span>${r.pElZero !== null ? `NPV = 0 при ${num(r.pElZero, 1)} ₽` : 'NPV не пересекает ноль'}</span><span>${r.pElZeroPct !== null ? `${r.pElZeroPct >= 0 ? '+' : '−'}${num(Math.abs(r.pElZeroPct) * 100, 0)}%` : ''}</span></div>
    </div>
    <div class="robust-row">
      <div class="robust-label">Спрос ниже или выше прогноза</div>
      <div class="robust-text">${r.demandZeroPct !== null ? `NPV = 0 при спросе ${r.demandZeroPct >= 0 ? '+' : '−'}${num(Math.abs(r.demandZeroPct) * 100, 0)}% к прогнозу` : 'NPV не пересекает ноль в диапазоне −95%…+400%'}</div>
    </div>
    ${vm.classBNpv !== null && vm.classBNpv !== undefined ? `<div class="robust-row"><div class="robust-label">Если подключение окажется классом Б (подстанция дальше 200 м)</div><div class="robust-text">NPV ${signedMln(vm.classBNpv)} млн ₽</div></div>` : ''}
    <div class="robust-verdict ${tone}">${verdict}</div>`;
}

// Ближайшая эталонная станция РСЗС и её результат в модели (ТЗ «Эталоны», шаг 3.4).
function benchRow(vm) {
  const b = vm.nearestBench;
  if (!b) return '';
  return `<div class="bench-row"><div class="bench-h">Ближайший эталон РСЗС</div>
    <div>${esc(b.address)}, ${num(b.distKm, 1)} км · ${b.type === 'weak' ? 'слабая' : 'лидер'} по данным РСЗС</div>
    <div class="pp-note">В модели ${num(b.S, 1)} сессий в сутки, загрузка ${pct(b.U, 1)}; место в сети РСЗС из ${b.N}: ${b.rankS} по сессиям, ${b.rankU} по загрузке${b.mismatch ? '. <b>Расхождение</b>: модель ещё не откалибрована на почасовых данных РСЗС, это закрывает пилот' : ''}.</div></div>`;
}

function whyBlock(vm) {
  return `${vm.why
    .map((w) => `<div class="why-row"><div class="why-label">${w.label}<small>${w.note}</small></div><div class="why-bar ${w.tone}"><i style="width:${Math.round(w.value * 100)}%"></i></div></div>`)
    .join('')}
    <p class="pp-note">Синее повышает прогноз, оранжевое снижает. Длина полосы — место этой точки среди всех зон города (100% — самая высокая).</p>
    ${benchRow(vm)}`;
}

function liveDetails(vm) {
  const L = vm.live;
  if (!L) return '';
  const maxBar = Math.max(1e-6, ...L.hourly);
  const bars = L.hourly.map((t, h) => `<div class="bar ${h === vm.hour ? 'bar-now' : ''} ${h === L.peakHour ? 'bar-peak' : ''}" style="height:${Math.max(2, (t / maxBar) * 100)}%" title="${h}:00: ${num(t, 2)} машин в час"></div>`).join('');
  const losers = L.neighbors.filter((n) => n.deltaS < 0);
  const maxLoss = Math.max(1e-6, ...losers.map((n) => -n.deltaS));
  const nbRows = (list) => list.map((n) => `<div class="nb-row"><span class="nb-name">${esc(n.label)}<small>сейчас ${num(n.S0, 1)} машин в сутки</small></span><span class="nb-bar"><i style="width:${(-n.deltaS / maxLoss) * 100}%"></i></span><span class="nb-val">−${num(-n.deltaS, 2)}</span></div>`).join('');
  return `
    <section class="pp-card pp-wide">
      <h3>Как станция работает в течение дня</h3>
      <p class="pp-note">${esc(L.conditions)}. Станция 150 кВт на 2 поста.</p>
      <div class="bar-chart">${bars}</div>
      <div class="bar-axis"><span>0:00</span><span>6:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>
      <p class="pp-note" id="pp-hour-note">${L.hourNote(vm.hour)}</p>
    </section>
    <section class="pp-card pp-wide">
      <h3>Новые клиенты и клиенты соседей</h3>
      <p class="pp-sentence">Из ${num(L.Snew, 1)} машин в сутки <b>${num(Math.max(0, L.newDemand), 1)}</b> — новые клиенты: без станции они уехали бы без зарядки. Ещё <b>${num(L.cannibalization, 1)}</b> перейдут с ${losers.length} ${plural(losers.length, 'соседней станции', 'соседних станций', 'соседних станций')}.</p>
      ${losers.length ? `<div class="nb-list">${nbRows(losers.slice(0, 6))}</div>` : '<p class="pp-note">Рядом нет станций, у которых новая заметно заберёт клиентов.</p>'}
      ${losers.length > 6 ? `<details class="nb-more"><summary>ещё ${losers.length - 6}</summary><div class="nb-list">${nbRows(losers.slice(6))}</div></details>` : ''}
    </section>
    ${
      L.equipmentRows
        ? `<details class="pp-card pp-wide equip-details"><summary>Все варианты оборудования</summary>
      <table class="data-table equip-table"><thead><tr><th>Станция</th><th>Класс</th><th>Машин в сутки<br>2026 → 2030</th><th>Из них новых<br>2026 → 2030</th><th>Новых на 1 млн ₽</th><th>NPV, млн ₽</th></tr></thead><tbody>${L.equipmentRows}</tbody></table>
      <p class="pp-note">Средний день года, сценарий как выше, дорогая граница подключения. Выделена станция с наибольшим числом новых клиентов на 1 млн ₽ вложений. Класс В: у питающего центра нет свободной мощности.</p></details>`
        : ''
    }
    <details class="pp-card pp-wide tech"><summary>Технические детали</summary>
      ${L.tech.map(([k, v]) => `<div class="metric-row"><span>${k}</span><span>${v}</span></div>`).join('')}
    </details>`;
}

export function renderPassport(container, vm) {
  const st = STATUS[vm.status];
  const S = vm.S[vm.year];
  const [sLo, sHi] = vm.Srange[vm.year];
  const econ = vm.econ;
  const paybackTone = econ && (econ.payback === null || econ.payback > vm.th.normYears) ? 'warn' : '';
  const npvTone = econ && econ.npv < 0 ? 'warn' : '';
  const capexLine = econ?.capexRange ? `${mln(econ.capexRange[0], 2)}–${mln(econ.capexRange[1], 2)} млн ₽` : '—';

  container.innerHTML = `
    <div class="pp-top">
      <div class="pp-head card">
        <div class="pp-kicker">Паспорт площадки до заявки на техприсоединение</div>
        <h1 class="pp-title">${esc(vm.subject.title)}<span>${esc(vm.subject.subtitle)}</span></h1>
        <div class="pp-address">${vm.subject.address ? esc(vm.subject.address) : 'Адрес не определён'} · ${vm.subject.lat.toFixed(5)}, ${vm.subject.lon.toFixed(5)}</div>
        <div class="pp-chips"><span class="mono-chip">Модель v2</span><span class="mono-chip">Сформирован ${esc(vm.dateStr)}</span><span class="mono-chip">${esc(vm.scenarioLabel)}</span></div>
        <div class="pp-actions">
          <button class="btn-primary" id="pp-print" type="button">Скачать паспорт PDF</button>
          <button class="btn-secondary" id="pp-copy" type="button">Скопировать для заявки</button>
          <button class="btn-link" id="pp-compare" type="button">${vm.inCompare ? 'Уже в сравнении' : 'Сравнить с другими точками'}</button>
        </div>
        ${vm.liveProgress ? `<div class="pp-progress"><div class="pp-progress-bar"><i style="width:${Math.round(vm.liveProgress.fraction * 100)}%"></i></div><span>${esc(vm.liveProgress.text)}</span></div>` : ''}
      </div>
      <div class="pp-verdict card-dark">
        <div class="pp-kicker">Рекомендация</div>
        ${
          econ?.tz
            ? `<div class="pp-verdict-title"><i class="dot dot-${VERDICT[econ.tz.verdict].tone}"></i>${VERDICT[econ.tz.verdict].label}</div>
        <div class="pp-verdict-cfg">Класс ${esc(vm.clsLabel)}, 150 кВт, 2 поста · очередь на карте: ${esc(vm.recTitle.toLowerCase())}</div>
        <p>${verdictText(vm)}</p>
        <p>${vm.recText}</p>`
            : `<div class="pp-verdict-title"><i class="dot dot-${st.tone}"></i>${esc(vm.recTitle)}</div>
        <div class="pp-verdict-cfg">Класс ${esc(vm.clsLabel)}, 150 кВт, 2 поста</div>
        <p>${vm.recText}</p>`
        }
        <div class="pp-verdict-ctl">
          <span class="ctl-label">Рост спроса в год</span>
          <div class="seg seg-dark" id="pp-scenario">${SCENARIO_BTNS.map(([v, l]) => `<button data-value="${v}" class="${v === vm.scenario ? 'active' : ''}">${l}</button>`).join('')}</div>
          <span class="ctl-label">Год решения</span>
          <div class="seg seg-dark" id="pp-year">${[2026, 2028, 2030].map((y) => `<button data-value="${y}" class="${y === vm.year ? 'active' : ''}">${y}</button>`).join('')}</div>
          <label class="switch"><input type="checkbox" id="pp-subsidy" ${vm.subsidy ? 'checked' : ''} ${vm.econLive ? '' : 'disabled'} /><span class="switch-ui"></span>Учесть компенсацию МФППиП: 50% платы за подключение, до 2 млн ₽</label>
        </div>
      </div>
    </div>

    <div class="pp-kpis">
      ${kpiTile({ label: `Прогноз на ${vm.year}`, value: num(S, 0), sub: `зарядок в сутки, диапазон ${num(sLo, 0)}–${num(sHi, 0)}` })}
      ${kpiTile({ label: 'Загрузка поста', value: pct(vm.U[vm.year], 1), sub: `окупаемость за ${vm.th.normYears} лет от ${pct(vm.th.uPb)}, с дисконтом от ${pct(vm.th.uNpv)}` })}
      ${kpiTile({ label: 'Простая окупаемость', value: econ ? paybackText(econ) : '…', unit: ' лет', sub: `решение в ${vm.year}, пуск через срок ТП; норматив РСЗС — ${vm.th.normYears} лет`, tone: paybackTone })}
      ${kpiTile({ label: `NPV за 10 лет с ${vm.year}, ставка 18%`, value: econ ? signedMln(econ.npv) : '…', unit: ' млн ₽', sub: econ ? (econ.npv >= 0 ? 'проект окупает стоимость капитала' : 'ниже нуля: не окупает стоимость капитала') : '', tone: npvTone })}
    </div>

    <div class="pp-grid">
      <section class="pp-card pp-chart-card">
        <h3>Загрузка поста по годам</h3>
        <p class="pp-note">Линия — прогноз, полоса — от выходного летом до будней зимой, пунктир — пороги окупаемости.</p>
        ${loadChart(vm)}
      </section>
      <section class="pp-card">
        <h3>Конфигурация и затраты</h3>
        <div class="metric-row"><span>Мощность и посты</span><span>150 кВт, 2 поста</span></div>
        <div class="metric-row"><span>Класс площадки</span><span>${esc(vm.clsText)}</span></div>
        <div class="metric-row"><span>Оборудование</span><span>DC150-2, ${mln(vm.costs.eq, 1)} млн ₽</span></div>
        <div class="metric-row"><span>CAPEX</span><span class="mono">${capexLine}</span></div>
        <div class="metric-row"><span>Аренда мест</span><span class="mono">${thousands(vm.costs.rentMonth)} в мес.</span></div>
        <div class="metric-row"><span>Обслуживание, связь, страховка</span><span class="mono">${thousands(vm.costs.serviceYear)} в год</span></div>
        <p class="pp-note">CAPEX: станция, подключение (дешёвая — дорогая граница класса), площадка и интеграция. Федеральной субсидии в Москве нет${vm.subsidy && econ?.subsidyRub ? `; МФППиП вернёт ${mln(econ.subsidyRub, 2)} млн ₽ за 3 года` : ''}. Аренда и обслуживание — допущения, РСЗС их не подтвердила.</p>
      </section>
    </div>

    <div class="pp-grid3">
      <section class="pp-card">
        <h3>Подключение к сети</h3>
        <div class="metric-row"><span>Подстанция 0,4 кВ</span><span>${vm.dist04 !== null ? `${vm.dist04} м` : '<span class="tag tag-warn">нет ближе 200 м</span>'}</span></div>
        <div class="metric-row"><span>Свободная мощность питающего центра</span><span>${vm.center ? `${num(vm.center.freeMW, 1)} МВт <span class="tag tag-warn">оценка</span>` : '…'}</span></div>
        <div class="metric-row"><span>Срок техприсоединения</span><span>${vm.conn ? `${num(vm.conn.months[0], 0)}–${num(vm.conn.months[1], 0)} мес.` : '—'}</span></div>
        <div class="metric-row"><span>Стоимость подключения</span><span class="mono">${vm.conn ? `${mln(vm.conn.cost[0], 2)}–${mln(vm.conn.cost[1], 2)} млн ₽` : '—'}</span></div>
        <div class="metric-row"><span>Компенсация МФППиП</span><span>${vm.subsidy ? (econ?.subsidyRub ? `учтена, ${mln(econ.subsidyRub, 2)} млн ₽ тремя платежами` : 'учтена') : 'не учтена'}</span></div>
        <p class="pp-note">${vm.dist04 !== null ? 'Класс А: известная подстанция ближе 200 м, подключение без реконструкции сети.' : 'Подстанции ближе 200 м в открытых данных нет — считаем как класс Б. Реальный класс и цену даст запрос в Россети.'} Свободная мощность — оценка по классу напряжения: официальной карты резерва нет.</p>
      </section>
      <section class="pp-card">
        <h3>Почему здесь</h3>
        ${whyBlock(vm)}
      </section>
      <section class="pp-card">
        <h3>Устойчивость вывода</h3>
        ${robustBlock(vm)}
      </section>
    </div>

    ${econBlock(vm)}
    ${yearTable(vm)}
    ${liveDetails(vm)}
    ${vm.liveProgress && !vm.live ? '<section class="pp-card pp-wide"><div class="skeleton"></div><p class="pp-note">Профиль по часам, соседи и варианты оборудования появятся после расчёта.</p></section>' : ''}

    <section class="pp-card pp-wide">
      <div class="pp-control-head"><h3>Контроль после ввода</h3><span class="pp-note">Предлагаемый порядок: если факт ниже прогноза больше чем на треть, карта зон пересчитывается.</span></div>
      <ol class="timeline">
        <li class="done"><span class="mono">01 · сейчас</span><b>Паспорт и заявка на ТП</b><small>паспорт прикладывается к заявке</small></li>
        <li><span class="mono">02 · ввод</span><b>Ввод станции</b><small>через ${vm.conn ? `${num(vm.conn.months[0], 0)}–${num(vm.conn.months[1], 0)}` : '6–12'} мес. после заявки</small></li>
        <li><span class="mono">03 · +6 мес.</span><b>Первая сверка</b><small>прогноз против почасовых сессий</small></li>
        <li><span class="mono">04 · +12 мес.</span><b>Решение о расширении</b><small>доступность в пик ниже 90% — сигнал</small></li>
      </ol>
    </section>

    <div class="assumptions"><span>Допущения модели</span>${vm.assumptions.map((a) => `<span class="mono-chip">${esc(a)}</span>`).join('')}</div>
  `;
}

export function updatePassportHour(vm) {
  if (!vm?.live) return;
  document.querySelectorAll('#passport .bar').forEach((el, h) => el.classList.toggle('bar-now', h === vm.hour));
  const note = document.getElementById('pp-hour-note');
  if (note) note.innerHTML = vm.live.hourNote(vm.hour);
}
