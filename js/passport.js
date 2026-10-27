// Паспорт площадки (спецификация, раздел 12.2) - документ до заявки на
// техприсоединение. Рисуется целиком из view-model, которую собирает app.js:
// сначала из готового расчёта зон (data/zones.json, мгновенно), затем из
// живого расчёта модулей 1-7 для этой точки (equipment.js + econ-view.js).
// Повторный вызов с обновлённой моделью (МФППиП, сценарий, конец расчёта)
// просто перерисовывает страницу. Тексты - для эксперта, который видит
// паспорт впервые: в каждом блоке сначала вывод простыми словами, потом цифры.
import { STATUS, VERDICT } from './econ-view.js';

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const num = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d).replace('.', ','));
const mln = (rub, d = 1) => (rub === null || rub === undefined || !Number.isFinite(rub) ? '—' : `${num(rub / 1e6, d)}`);
const signedMln = (rub) => (Number.isFinite(rub) ? `${rub >= 0 ? '+' : '−'}${num(Math.abs(rub) / 1e6, 1)}` : '—');
const pct = (v, d = 0) => (Number.isFinite(v) ? `${num(v * 100, d)}%` : '—');
const thousands = (rub) => `${Math.round(rub / 1000).toLocaleString('ru-RU')} тыс. ₽`;
const years = (v) => (v === null || v === undefined ? 'больше 10 лет' : `${num(v, 1)} ${plural(Math.round(v), 'год', 'года', 'лет')}`);

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const SCENARIO_BTNS = [
  ['base', '+30% в год · базовый'],
  ['fast', '+80% в год · быстрый'],
];

// Загрузка поста по годам: линия прогноза, полоса - разброс между режимами
// дня (выходной лета ... будни зимы), пунктир - пороги окупаемости.
function loadChart(vm) {
  const ys = [2026, 2027, 2028, 2029, 2030];
  const U = ys.map((y) => vm.U[y]);
  const lo = ys.map((y) => vm.Urange[y][0]);
  const hi = ys.map((y) => vm.Urange[y][1]);
  const top = Math.max(0.3, ...hi, vm.th.uNpv * 1.25);
  const W = 560;
  const H = 230;
  const pad = { l: 40, r: 92, t: 18, b: 28 };
  const x = (i) => pad.l + (i * (W - pad.l - pad.r)) / (ys.length - 1);
  const y = (u) => pad.t + (1 - u / top) * (H - pad.t - pad.b);
  const band = `M${ys.map((_, i) => `${x(i)},${y(hi[i])}`).join(' L')} L${ys.map((_, i) => `${x(ys.length - 1 - i)},${y(lo[ys.length - 1 - i])}`).join(' L')} Z`;
  const line = `M${ys.map((_, i) => `${x(i)},${y(U[i])}`).join(' L')}`;
  const grid = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6].filter((g) => g <= top + 1e-9);
  const thLine = (u, label, cls) =>
    u <= top ? `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(u)}" y2="${y(u)}" class="th ${cls}"/><text x="${W - pad.r + 6}" y="${y(u) + 4}" class="th-label">${label}</text>` : '';
  return `<svg class="load-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Загрузка поста по годам">
    ${grid.map((g) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(g)}" y2="${y(g)}" class="grid"/><text x="${pad.l - 8}" y="${y(g) + 4}" class="axis" text-anchor="end">${Math.round(g * 100)}%</text>`).join('')}
    <path d="${band}" class="band"/>
    ${thLine(vm.th.uNpv, `${num(vm.th.uNpv * 100, 0)}% с дисконтом`, 'th-npv')}
    ${thLine(vm.th.uPb, `${num(vm.th.uPb * 100, 0)}% окупаемость`, 'th-pb')}
    <path d="${line}" class="line"/>
    ${ys
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

// «При каком спросе точка окупится» (предложение команды 27.10): сколько
// зарядок в сутки нужно, чтобы уложиться в норматив РСЗС, против прогноза.
function needBlock(vm) {
  const n = vm.econ?.need;
  if (!n) return '';
  const N = vm.th.normYears;
  const sure = n.expensive;
  const best = n.cheap;
  const fc = n.forecast;
  // Вторая планка - NPV > 0 (заработать больше стоимости денег, ставка 18%):
  // из «Насколько надёжен вывод», при дорогом подключении, как вердикт.
  const dz = vm.robust?.demandZeroPct;
  const npvNeed = dz === null || dz === undefined ? null : (1 + dz) * fc;
  const ratioText = (x) => {
    if (!x) return 'не окупается даже при спросе в 10 раз выше';
    const d = x.mult - 1;
    if (d <= 0) return `прогноз выше нужного на ${num(-d * 100, 0)}%`;
    return `спрос должен быть на ${num(d * 100, 0)}% выше прогноза`;
  };
  let headline;
  let tone;
  if (sure && sure.mult <= 1) {
    headline = `Окупится за ${N} лет при любой цене подключения: прогноз ${num(fc, 1)} зарядки в сутки, а нужно ${num(sure.sessions, 1)}.`;
    tone = 'ok';
  } else if (best && best.mult <= 1) {
    headline = `Окупится за ${N} лет, только если подключение окажется дешёвым. С дорогим подключением нужно ${num(sure?.sessions, 1)} зарядки в сутки, прогноз — ${num(fc, 1)}.`;
    tone = 'warn';
  } else if (sure) {
    headline = `Чтобы окупиться за ${N} лет, точке нужно ${num(sure.sessions, 1)} зарядки в сутки. Прогноз — ${num(fc, 1)}${sure.year && sure.year > vm.year ? `; такого спроса модель ждёт к ${sure.year} году` : ''}.`;
    tone = 'warn';
  } else {
    headline = `За ${N} лет точка не окупается даже при спросе в 10 раз выше прогноза.`;
    tone = 'bad';
  }
  const bar = (x) => {
    if (!x) return '';
    const max = Math.max(x.sessions, fc) * 1.15;
    return `<div class="need-bar"><i class="need-fc" style="width:${(fc / max) * 100}%"></i><b class="need-mk" style="left:${(x.sessions / max) * 100}%"></b></div>`;
  };
  if (npvNeed !== null) {
    headline +=
      npvNeed <= fc
        ? ` И станция заработает больше, чем стоят вложенные деньги: для этого нужно ${num(npvNeed, 1)}.`
        : ` Но чтобы заработать больше, чем стоят вложенные деньги (ставка 18%), нужно ${num(npvNeed, 1)} — на ${num(dz * 100, 0)}% больше прогноза. Поэтому вердикт сверху осторожнее.`;
  }
  return `<section class="pp-card pp-wide need-card need-${tone}">
    <h3>При каком спросе точка окупится</h3>
    <p class="need-headline">${headline}</p>
    <div class="need-grid">
      <div><div class="need-label">Наверняка — даже при дорогом подключении</div><div class="need-value">${sure ? `${num(sure.sessions, 1)}` : '—'}<small> зарядки в сутки</small></div>${bar(sure)}<div class="pp-note">${ratioText(sure)}</div></div>
      <div><div class="need-label">В лучшем случае — при дешёвом подключении</div><div class="need-value">${best ? `${num(best.sessions, 1)}` : '—'}<small> зарядки в сутки</small></div>${bar(best)}<div class="pp-note">${ratioText(best)}</div></div>
      <div><div class="need-label">Чтобы заработать больше стоимости денег (NPV > 0)</div><div class="need-value">${npvNeed !== null ? num(npvNeed, 1) : '—'}<small> зарядки в сутки</small></div>${npvNeed !== null ? bar({ sessions: npvNeed }) : ''}<div class="pp-note">${npvNeed === null ? 'вне диапазона расчёта' : npvNeed <= fc ? `прогноз выше нужного на ${num((fc / npvNeed - 1) * 100, 0)}%` : `спрос должен быть на ${num(dz * 100, 0)}% выше прогноза`}</div></div>
    </div>
    <p class="need-forecast">Прогноз модели на ${vm.year}: <b>${num(fc, 1)} зарядки в сутки</b> (средний день года, ${esc(vm.scenarioLabel)}).</p>
    <p class="pp-note">Синяя полоса — прогноз, чёрная отметка — сколько нужно. «Окупится» — вложения вернутся за ${N} лет (норматив РСЗС). «Больше стоимости денег» — станция заработает больше, чем принесли бы те же деньги под 18% за 10 лет. Расчёт от года решения с ростом спроса по модели${vm.subsidy ? ', с компенсацией МФППиП' : ''}.</p>
  </section>`;
}

function yearTable(vm) {
  if (!vm.yearRows) return '';
  const cols = vm.yearRows;
  const row = (label, f, hint = '') => `<tr><td>${label}${hint ? `<small class="metric-note">${hint}</small>` : ''}</td>${cols.map((c) => `<td class="num">${f(c)}</td>`).join('')}</tr>`;
  return `<section class="pp-card pp-wide">
    <h3>Прогноз по годам</h3>
    <p class="pp-note">Средний день года, ${esc(vm.scenarioLabel)}. Город в 2027–2030 открывает свои станции, поэтому спрос точки растёт не всегда ровно.</p>
    <table class="data-table year-table"><thead><tr><th></th>${cols.map((c) => `<th class="num">${c.year}</th>`).join('')}</tr></thead><tbody>
      ${row('Зарядок в сутки', (c) => num(c.S, 1))}
      ${row('Загрузка поста', (c) => pct(c.U, 1), 'доля времени, когда пост занят')}
      ${row('Доля такси', (c) => pct(c.taxi), 'такси платит меньше, 19 ₽ вместо 23 ₽')}
      ${row('Пост свободен в зимний будний день', (c) => pct(c.free), 'шанс подъехать и сразу встать на зарядку')}
      ${row('Новых клиентов для города', (c) => num(Math.max(0, c.gain), 1), 'без этой станции они не зарядились бы')}
    </tbody></table>
    ${vm.ownLoss !== null ? `<p class="pp-note">Остальные зарядки перейдут с соседних станций. У станций самой РСЗС точка заберёт около ${num(vm.ownLoss, 1)} зарядки в сутки.</p>` : ''}
  </section>`;
}

// Вердикт по правилу ТЗ (BR-22): строить / запросить ТУ / не строить.
function verdictText(vm) {
  const t = vm.econ.tz;
  const r = vm.econ.paybackRange || [];
  if (t.verdict === 'build') return `Станция вернёт вложения за ${paybackText(vm.econ)} лет — в пределах норматива РСЗС (${vm.th.normYears} лет) — и заработает сверх стоимости денег даже при дорогом подключении.`;
  if (t.verdict === 'request') return 'Станция выгодна, только если подключение окажется дешёвым. Нужны технические условия от сетевой компании: от реальной цены подключения зависит ответ.';
  return `Даже при дешёвом подключении станция не зарабатывает больше, чем стоят вложенные деньги${r[0] === null ? ', и за 10 лет не окупается' : ''}.`;
}

function econBlock(vm) {
  const t = vm.econ?.tz;
  if (!t) return '';
  const rng = (a) => `${mln(a[0], 2)}–${mln(a[1], 2)}`;
  const row = (k, v, note = '') => `<div class="metric-row"><span>${k}${note ? `<small class="metric-note">${note}</small>` : ''}</span><span class="mono">${v}</span></div>`;
  const marginTone = t.margin >= 1 ? 'ok' : 'warn';
  return `<section class="pp-card pp-wide">
    <h3>Деньги: станция и вся сеть РСЗС</h3>
    <p class="pp-note">Решение в ${vm.year} году, станция 150 кВт на 2 поста, 10 лет работы, ставка 18%. ${vm.subsidy ? 'Компенсация МФППиП учтена.' : 'Без компенсации МФППиП.'}</p>
    <div class="econ-grid">
      <div>
        ${row('Зарабатываем с одной зарядки', `${num(t.mBar, 0)} ₽`, 'тариф минус электроэнергия, НДС и эквайринг; такси и зима снижают')}
        ${row('Зарядок в сутки', num(t.N, 1), `средний день ${t.year} года`)}
        ${row('Загрузка поста', pct(vm.U[t.year], 1), 'ориентир РСЗС — 8–10% к концу первого года')}
        ${row('Остаётся за год после расходов', `${signedMln(t.cfYear)} млн ₽`, `маржа со всех зарядок минус ${mln(t.F, 2)} млн постоянных расходов`)}
        ${row('Вложения', `${rng(t.capexNoSub)} млн ₽`, 'станция, подключение, площадка')}
        ${row('Вложения с компенсацией МФППиП', `${rng(t.capexMfppip)} млн ₽`, 'город возвращает 50% платы за подключение')}
      </div>
      <div>
        ${row('Окупаемость', `${paybackText(vm.econ)} лет`, `когда вернутся вложения; норматив РСЗС — ${vm.th.normYears} лет`)}
        ${row('Окупаемость с учётом стоимости денег', t.paybackDisc === null ? 'больше 10 лет' : years(t.paybackDisc), 'то же при ставке 18%')}
        ${row('NPV станции', `${signedMln(t.npvStation)} млн ₽`, 'сколько станция заработает сверх вложений и ставки')}
        ${row('NPV для всей сети РСЗС', `${signedMln(t.npvNetwork)} млн ₽`, 'без зарядок, которые просто перейдут со станций РСЗС')}
        ${row('Безубыточность', `${num(t.Sstar, 1)} зарядки в сутки`, `загрузка ${pct(t.Ustar, 1)}; столько нужно, чтобы вернуть вложения со ставкой`)}
        <div class="metric-row"><span>Запас прочности<small class="metric-note">прогноз ÷ безубыточность; больше 1 — с запасом</small></span><span class="mono tone-${marginTone}">${num(t.margin, 2)}</span></div>
      </div>
    </div>
  </section>`;
}

// Главное о точке в трёх строках - в шапке паспорта.
function summaryList(vm) {
  const S = vm.S[vm.year];
  const n = vm.econ?.need;
  const need = n?.expensive?.sessions;
  const items = [];
  items.push(
    need
      ? `<b>Спрос.</b> Прогноз ${num(S, 1)} зарядки в сутки, для окупаемости за ${vm.th.normYears} лет нужно ${num(need, 1)} — ${S >= need ? 'хватает' : `не хватает ${num(need - S, 1)}`}.`
      : `<b>Спрос.</b> Прогноз ${num(S, 1)} зарядки в сутки в ${vm.year} году.`
  );
  if (vm.econ?.paybackRange) items.push(`<b>Деньги.</b> Вложения ${mln(vm.econ.capexRange[0], 1)}–${mln(vm.econ.capexRange[1], 1)} млн ₽, вернутся за ${paybackText(vm.econ)} лет.`);
  items.push(
    vm.dist04 !== null
      ? `<b>Сеть.</b> Подстанция в ${vm.dist04} м — подключение дешёвое, ${vm.conn ? `${num(vm.conn.months[0], 0)}–${num(vm.conn.months[1], 0)} мес.` : ''}`
      : '<b>Сеть.</b> Подстанции рядом нет — нужен запрос в «Россети», подключение может быть дорогим.'
  );
  if (vm.live && vm.live.Snew > 0) items.push(`<b>Клиенты.</b> Около ${pct(Math.max(0, vm.live.newDemand) / vm.live.Snew)} зарядок — новые клиенты, остальные перейдут с соседних станций.`);
  return `<ul class="pp-summary">${items.map((t) => `<li>${t}</li>`).join('')}</ul>`;
}

function kpiTile({ label, value, unit = '', sub = '', tone = '' }) {
  return `<div class="pp-kpi"><div class="pp-kpi-top"><span>${label}</span></div><div class="pp-kpi-value ${tone}">${value}${unit ? `<small>${unit}</small>` : ''}</div><div class="pp-kpi-sub">${sub}</div></div>`;
}

function robustBlock(vm) {
  if (!vm.robust) return '<div class="skeleton"></div><p class="pp-note">Считается вместе с точным прогнозом…</p>';
  const r = vm.robust;
  const [pMin, pMax] = r.pElRange;
  const scaleLo = Math.min(pMin, r.pElZero ?? pMin) * 0.8;
  const scaleHi = Math.max(pMax, r.pElZero ?? pMax) * 1.1;
  const pos = (v) => `${(((v - scaleLo) / (scaleHi - scaleLo)) * 100).toFixed(1)}%`;
  const npvPositive = vm.econ.npv > 0;
  const dz = r.demandZeroPct;
  let verdict;
  let tone;
  if (npvPositive && (r.pElZero === null || r.pElZero > pMax)) {
    verdict = `Вывод надёжный: станция выгодна даже при самой дорогой электроэнергии (${num(pMax, 0)} ₽)${dz !== null ? ` и при спросе на ${num(-dz * 100, 0)}% ниже прогноза` : ''}.`;
    tone = 'ok';
  } else if (npvPositive) {
    verdict = `Вывод хрупкий: если электроэнергия подорожает до ${num(r.pElZero, 1)} ₽ (на ${num(Math.abs(r.pElZeroPct) * 100, 0)}%), станция перестанет быть выгодной.`;
    tone = 'warn';
  } else {
    verdict =
      r.pElZero !== null && r.pElZero > 0
        ? `Сейчас невыгодно. Станция станет выгодной при электроэнергии дешевле ${num(r.pElZero, 1)} ₽${dz !== null ? ` или при спросе на ${num(dz * 100, 0)}% выше прогноза` : ''}.`
        : `Сейчас невыгодно при любой цене электроэнергии${dz !== null ? `; нужен спрос на ${num(dz * 100, 0)}% выше прогноза` : ''}.`;
    tone = 'warn';
  }
  return `
    <p class="pp-note">Что должно измениться, чтобы вывод поменялся.</p>
    <div class="robust-row">
      <div class="robust-label">Цена электроэнергии: в расчёте ${num(r.pElBase, 0)} ₽, реальный диапазон ${num(pMin, 0)}–${num(pMax, 0)} ₽ за кВт·ч</div>
      <div class="robust-scale"><span class="rs-range" style="left:${pos(pMin)};width:calc(${pos(pMax)} - ${pos(pMin)})"></span><span class="rs-base" style="left:${pos(r.pElBase)}"></span>${r.pElZero !== null ? `<span class="rs-zero" style="left:${pos(r.pElZero)}"></span>` : ''}</div>
      <div class="robust-ends"><span>${r.pElZero !== null ? `граница выгоды — ${num(r.pElZero, 1)} ₽` : 'граница вне диапазона'}</span><span>${r.pElZeroPct !== null ? `${r.pElZeroPct >= 0 ? '+' : '−'}${num(Math.abs(r.pElZeroPct) * 100, 0)}% к расчёту` : ''}</span></div>
    </div>
    <div class="robust-row">
      <div class="robust-label">Спрос</div>
      <div class="robust-text">${dz !== null ? `граница выгоды — спрос ${dz >= 0 ? 'на ' + num(dz * 100, 0) + '% выше' : 'на ' + num(-dz * 100, 0) + '% ниже'} прогноза` : 'граница вне диапазона −95%…+400%'}</div>
    </div>
    ${vm.classBNpv !== null && vm.classBNpv !== undefined ? `<div class="robust-row"><div class="robust-label">Если подключение окажется дорогим (класс Б)</div><div class="robust-text">NPV ${signedMln(vm.classBNpv)} млн ₽</div></div>` : ''}
    <div class="robust-verdict ${tone}">${verdict}</div>`;
}

// Ближайшая эталонная станция РСЗС и её результат в модели (ТЗ «Эталоны», шаг 3.4).
function benchRow(vm) {
  const b = vm.nearestBench;
  if (!b) return '';
  return `<div class="bench-row"><div class="bench-h">Ближайшая эталонная станция РСЗС</div>
    <div>${esc(b.address)}, ${num(b.distKm, 1)} км — по данным РСЗС ${b.type === 'weak' ? 'слабая' : 'одна из самых востребованных'}</div>
    <div class="pp-note">Модель даёт ей ${num(b.S, 1)} зарядки в сутки (${b.rankS}-е место из ${b.N} станций РСЗС), загрузку ${pct(b.U, 1)} (${b.rankU}-е место)${b.mismatch ? '. По загрузке модель пока расходится с РСЗС — это уточнится на почасовых данных в пилоте' : ''}.</div></div>`;
}

function whyBlock(vm) {
  return `<p class="pp-note">Что повышает и что снижает прогноз в этом месте.</p>
    ${vm.why
      .map((w) => `<div class="why-row"><div class="why-label">${w.label}<small>${w.note}</small></div><div class="why-bar ${w.tone}"><i style="width:${Math.round(w.value * 100)}%"></i></div></div>`)
      .join('')}
    <p class="pp-note">Синие полосы помогают, оранжевая мешает. Длина — насколько это место выше других зон города (полная полоса — максимум по Москве).</p>
    ${benchRow(vm)}`;
}

function liveDetails(vm) {
  const L = vm.live;
  if (!L) return '';
  const maxBar = Math.max(1e-6, ...L.hourly);
  const bars = L.hourly.map((t, h) => `<div class="bar ${h === vm.hour ? 'bar-now' : ''} ${h === L.peakHour ? 'bar-peak' : ''}" style="height:${Math.max(2, (t / maxBar) * 100)}%" title="${h}:00 — ${num(t, 2)} машин в час"></div>`).join('');
  const losers = L.neighbors.filter((n) => n.deltaS < 0);
  const maxLoss = Math.max(1e-6, ...losers.map((n) => -n.deltaS));
  const nbRows = (list) => list.map((n) => `<div class="nb-row"><span class="nb-name">${esc(n.label)}<small>сейчас ${num(n.S0, 1)} зарядки в сутки</small></span><span class="nb-bar"><i style="width:${(-n.deltaS / maxLoss) * 100}%"></i></span><span class="nb-val">−${num(-n.deltaS, 2)}</span></div>`).join('');
  return `
    <section class="pp-card pp-wide">
      <h3>Когда приезжают машины</h3>
      <p class="pp-note">${esc(L.conditions)}. Высота столбика — сколько машин заряжается в этот час.</p>
      <div class="bar-chart">${bars}</div>
      <div class="bar-axis"><span>0:00</span><span>6:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>
      <p class="pp-note" id="pp-hour-note">${L.hourNote(vm.hour)}</p>
    </section>
    <section class="pp-card pp-wide">
      <h3>Откуда придут клиенты</h3>
      <p class="pp-sentence">Из ${num(L.Snew, 1)} зарядок в сутки <b>${num(Math.max(0, L.newDemand), 1)}</b> — новые клиенты: без этой станции они уехали бы без зарядки или не дождались очереди. Остальные <b>${num(L.cannibalization, 1)}</b> перейдут с ${losers.length} ${plural(losers.length, 'соседней станции', 'соседних станций', 'соседних станций')}:</p>
      ${losers.length ? `<div class="nb-list">${nbRows(losers.slice(0, 6))}</div>` : '<p class="pp-note">Рядом нет станций, у которых новая заметно заберёт клиентов.</p>'}
      ${losers.length > 6 ? `<details class="nb-more"><summary>ещё ${losers.length - 6}</summary><div class="nb-list">${nbRows(losers.slice(6))}</div></details>` : ''}
    </section>
    ${
      L.equipmentRows
        ? `<details class="pp-card pp-wide equip-details"><summary>Сравнить с другими вариантами станции</summary>
      <table class="data-table equip-table"><thead><tr><th>Станция</th><th>Класс подключения</th><th>Зарядок в сутки<br>2026 → 2030</th><th>Из них новых<br>2026 → 2030</th><th>Новых на 1 млн ₽</th><th>NPV, млн ₽</th></tr></thead><tbody>${L.equipmentRows}</tbody></table>
      <p class="pp-note">DC60-1 — 60 кВт, один пост; DC150-2 — 150 кВт, два поста и т. д. Выделен вариант, который даёт больше всего новых клиентов на каждый вложенный миллион.</p></details>`
        : ''
    }
    <details class="pp-card pp-wide tech"><summary>Технические детали расчёта</summary>
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
        <div class="pp-kicker">Паспорт площадки — всё, что нужно знать до заявки на подключение</div>
        <h1 class="pp-title">${esc(vm.subject.title)}<span>${esc(vm.subject.subtitle)}</span></h1>
        <div class="pp-address">${vm.subject.address ? esc(vm.subject.address) : 'Адрес не определён'} · ${vm.subject.lat.toFixed(5)}, ${vm.subject.lon.toFixed(5)}</div>
        <div class="pp-chips"><span class="mono-chip">Сформирован ${esc(vm.dateStr)}</span><span class="mono-chip">${esc(vm.scenarioLabel)}</span><span class="mono-chip">решение в ${vm.year}</span></div>
        ${summaryList(vm)}
        <div class="pp-actions">
          <button class="btn-primary" id="pp-print" type="button">Скачать паспорт PDF</button>
          <button class="btn-secondary" id="pp-copy" type="button">Скопировать для заявки</button>
          <button class="btn-link" id="pp-compare" type="button">${vm.inCompare ? 'Уже в сравнении' : 'Сравнить с другими точками'}</button>
        </div>
        ${vm.liveProgress ? `<div class="pp-progress"><div class="pp-progress-bar"><i style="width:${Math.round(vm.liveProgress.fraction * 100)}%"></i></div><span>${esc(vm.liveProgress.text)}</span></div>` : ''}
      </div>
      <div class="pp-verdict card-dark">
        <div class="pp-kicker">Вывод</div>
        ${
          econ?.tz
            ? `<div class="pp-verdict-title"><i class="dot dot-${VERDICT[econ.tz.verdict].tone}"></i>${VERDICT[econ.tz.verdict].label}</div>
        <div class="pp-verdict-cfg">Станция 150 кВт, 2 поста · подключение класса ${esc(vm.clsLabel)} · на карте: ${esc(vm.recTitle.toLowerCase())}</div>
        <p>${verdictText(vm)}</p>
        <p>${vm.recText}</p>`
            : `<div class="pp-verdict-title"><i class="dot dot-${st.tone}"></i>${esc(vm.recTitle)}</div>
        <div class="pp-verdict-cfg">Станция 150 кВт, 2 поста · подключение класса ${esc(vm.clsLabel)}</div>
        <p>${vm.recText}</p>`
        }
        <div class="pp-verdict-ctl">
          <span class="ctl-label">Рост спроса на зарядку</span>
          <div class="seg seg-dark" id="pp-scenario">${SCENARIO_BTNS.map(([v, l]) => `<button data-value="${v}" class="${v === vm.scenario ? 'active' : ''}">${l}</button>`).join('')}</div>
          <span class="ctl-label">Год решения о станции</span>
          <div class="seg seg-dark" id="pp-year">${[2026, 2028, 2030].map((y) => `<button data-value="${y}" class="${y === vm.year ? 'active' : ''}">${y}</button>`).join('')}</div>
          <label class="switch"><input type="checkbox" id="pp-subsidy" ${vm.subsidy ? 'checked' : ''} ${vm.econLive ? '' : 'disabled'} /><span class="switch-ui"></span>Учесть компенсацию МФППиП — город возвращает 50% платы за подключение, до 2 млн ₽</label>
        </div>
      </div>
    </div>

    <div class="pp-kpis">
      ${kpiTile({ label: `Зарядок в сутки в ${vm.year}`, value: num(S, 0), sub: `обычно от ${num(sLo, 0)} (выходной летом) до ${num(sHi, 0)} (будни зимой)` })}
      ${kpiTile({ label: 'Загрузка поста', value: pct(vm.U[vm.year], 1), sub: `доля времени, когда пост занят; окупаемость начинается примерно с ${pct(vm.th.uPb)}` })}
      ${kpiTile({ label: 'Окупаемость', value: econ ? paybackText(econ) : '…', unit: ' лет', sub: `норматив РСЗС — ${vm.th.normYears} лет; диапазон — от дешёвого до дорогого подключения`, tone: paybackTone })}
      ${kpiTile({ label: 'NPV за 10 лет', value: econ ? signedMln(econ.npv) : '…', unit: ' млн ₽', sub: econ ? (econ.npv >= 0 ? 'станция зарабатывает больше, чем стоят вложенные деньги (ставка 18%)' : 'меньше нуля: заработок не покрывает стоимость денег (ставка 18%)') : '', tone: npvTone })}
    </div>

    ${needBlock(vm)}

    <div class="pp-grid">
      <section class="pp-card pp-chart-card">
        <h3>Загрузка поста по годам</h3>
        <p class="pp-note">Линия — прогноз на средний день, полоса — от выходного летом до будней зимой. Пунктир — с какой загрузки станция окупается за ${vm.th.normYears} лет и окупается с учётом ставки.</p>
        ${loadChart(vm)}
      </section>
      <section class="pp-card">
        <h3>Станция и затраты</h3>
        <div class="metric-row"><span>Станция</span><span>DC150-2: 150 кВт, 2 поста</span></div>
        <div class="metric-row"><span>Подключение</span><span>${esc(vm.clsText)}</span></div>
        <div class="metric-row"><span>Оборудование</span><span class="mono">${mln(vm.costs.eq, 1)} млн ₽</span></div>
        <div class="metric-row"><span>Все вложения</span><span class="mono">${capexLine}</span></div>
        <div class="metric-row"><span>Аренда двух мест</span><span class="mono">${thousands(vm.costs.rentMonth)} в мес.</span></div>
        <div class="metric-row"><span>Обслуживание, связь, страховка</span><span class="mono">${thousands(vm.costs.serviceYear)} в год</span></div>
        <p class="pp-note">Вложения — станция, подключение, подготовка площадки. Федеральной субсидии в Москве нет${vm.subsidy && econ?.subsidyRub ? `; по программе МФППиП город вернёт ${mln(econ.subsidyRub, 2)} млн ₽ за 3 года` : ''}. Аренда и обслуживание — наши допущения, РСЗС их пока не подтвердила.</p>
      </section>
    </div>

    <div class="pp-grid3">
      <section class="pp-card">
        <h3>Подключение к электросети</h3>
        <div class="metric-row"><span>Трансформаторная подстанция</span><span>${vm.dist04 !== null ? `в ${vm.dist04} м` : '<span class="tag tag-warn">ближе 200 м нет</span>'}</span></div>
        <div class="metric-row"><span>Свободная мощность питающего центра</span><span>${vm.center ? `${num(vm.center.freeMW, 1)} МВт <span class="tag tag-warn">оценка</span>` : '…'}</span></div>
        <div class="metric-row"><span>Срок подключения</span><span>${vm.conn ? `${num(vm.conn.months[0], 0)}–${num(vm.conn.months[1], 0)} мес.` : '—'}</span></div>
        <div class="metric-row"><span>Плата за подключение</span><span class="mono">${vm.conn ? `${mln(vm.conn.cost[0], 2)}–${mln(vm.conn.cost[1], 2)} млн ₽` : '—'}</span></div>
        <div class="metric-row"><span>Компенсация МФППиП</span><span>${vm.subsidy ? (econ?.subsidyRub ? `${mln(econ.subsidyRub, 2)} млн ₽ за 3 года` : 'учтена') : 'не учтена'}</span></div>
        <p class="pp-note">${vm.dist04 !== null ? 'Подстанция рядом — подключение без стройки новой сети, это класс А: дешевле и быстрее.' : 'В открытых данных подстанции ближе 200 м нет, поэтому считаем осторожно, как дорогой класс Б. Точную цену даст запрос в «Россети».'} Свободная мощность — наша оценка: официальной карты резерва нет.</p>
      </section>
      <section class="pp-card">
        <h3>Почему здесь</h3>
        ${whyBlock(vm)}
      </section>
      <section class="pp-card">
        <h3>Насколько надёжен вывод</h3>
        ${robustBlock(vm)}
      </section>
    </div>

    ${econBlock(vm)}
    ${yearTable(vm)}
    ${liveDetails(vm)}
    ${vm.liveProgress && !vm.live ? '<section class="pp-card pp-wide"><div class="skeleton"></div><p class="pp-note">Часы приезда, соседние станции и другие варианты станции появятся через несколько секунд.</p></section>' : ''}

    <section class="pp-card pp-wide">
      <div class="pp-control-head"><h3>Что дальше: проверка после запуска</h3><span class="pp-note">Если через полгода факт окажется ниже прогноза больше чем на треть, модель перенастраивается и карта пересчитывается.</span></div>
      <ol class="timeline">
        <li class="done"><span class="mono">01 · сейчас</span><b>Паспорт и заявка на подключение</b><small>паспорт прикладывается к заявке</small></li>
        <li><span class="mono">02 · запуск</span><b>Станция начинает работать</b><small>через ${vm.conn ? `${num(vm.conn.months[0], 0)}–${num(vm.conn.months[1], 0)}` : '6–12'} мес. после заявки</small></li>
        <li><span class="mono">03 · через 6 мес.</span><b>Сверка прогноза с фактом</b><small>по почасовым данным станции</small></li>
        <li><span class="mono">04 · через 12 мес.</span><b>Решение о расширении</b><small>если в час пик часто нет свободного поста</small></li>
      </ol>
    </section>

    <div class="assumptions"><span>Исходные допущения</span>${vm.assumptions.map((a) => `<span class="mono-chip">${esc(a)}</span>`).join('')}</div>
  `;
}

export function updatePassportHour(vm) {
  if (!vm?.live) return;
  document.querySelectorAll('#passport .bar').forEach((el, h) => el.classList.toggle('bar-now', h === vm.hour));
  const note = document.getElementById('pp-hour-note');
  if (note) note.innerHTML = vm.live.hourNote(vm.hour);
}
