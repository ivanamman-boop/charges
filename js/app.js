// Точка входа статического сайта. Пока только подвал с источниками данных
// (раздел 12.1) — карта и паспорт площадки добавляются в понедельник.
const DATA_FILES = ['cells', 'stations', 'centers', 'params'];

async function loadFooter() {
  const footer = document.getElementById('data-footer');
  const lines = [];
  for (const name of DATA_FILES) {
    try {
      const res = await fetch(`data/${name}.json`);
      const json = await res.json();
      lines.push(`<div>${name}.json — ${json.source} (${json.date})</div>`);
    } catch (e) {
      lines.push(`<div>${name}.json — не удалось загрузить</div>`);
    }
  }
  lines.push('<div>Версия модели: v1 (прототип, каркас) · Спецификация: docs/spec.txt</div>');
  footer.innerHTML = lines.join('\n');
}

loadFooter();
