// Объезд Яндекс.Карт (DevTools → Network → Save all as HAR with content,
// поиск "Электрозаправки") → scripts/data-sources/yandex-charging-stations-compact.json.
//
// Поиск Яндекса возвращает вперемешку со станциями и обычные организации
// (при поиске по адресу, "похожие места" и т.п.). Первые объезды 20.09 и
// 23.09 сводились вручную без фильтра по рубрике - в данные попали 70
// не-станций (музеи, рестораны, школы, консерватория, синагога), модель
// считала их конкурентами (аудит 24.09). Теперь запись берётся, только если
// у неё рубрика "Станция зарядки электромобилей" (seoname
// electric_car_charging_station), а записи компактного файла, которые в
// каком-либо HAR видны с другой рубрикой, удаляются.
//
// Запуск: npm run import:yandex -- ~/Downloads/yandex.ru.har ~/Downloads/yandex.22ru.har ...
// Дальше - обычная цепочка: fetch:stations → merge:yandex → clip:mkad → add:planned.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPACT_PATH = join(__dirname, 'data-sources', 'yandex-charging-stations-compact.json');
const EV_SEONAME = 'electric_car_charging_station';

const harPaths = process.argv.slice(2);
if (harPaths.length === 0) {
  console.error('укажите пути к HAR-файлам');
  process.exit(1);
}

const isEv = (item) => (item.categories || item.categoryIcons || []).some((c) => c.seoname === EV_SEONAME);
const toCompact = (item) => ({
  id: item.id,
  title: item.title,
  chainName: item.chain?.name ?? null,
  coordinates: item.coordinates,
  address: item.address,
  features: item.features ?? [],
});

const seen = new Map(); // id -> { ev, item }
for (const path of harPaths) {
  const har = JSON.parse(readFileSync(path, 'utf8'));
  let responses = 0;
  for (const entry of har.log.entries) {
    const content = entry.response?.content;
    let text = content?.text;
    if (!text) continue;
    if (content.encoding === 'base64') text = Buffer.from(text, 'base64').toString('utf8');
    if (!text.includes('totalResultCount')) continue;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const items = json.data?.items || [];
    if (items.length) responses++;
    for (const item of items) if (item.id && item.coordinates) seen.set(item.id, { ev: isEv(item), item });
  }
  console.log(`${basename(path)}: ответов поиска ${responses}`);
}

const compact = JSON.parse(readFileSync(COMPACT_PATH, 'utf8'));
const before = compact.items.length;
const removed = compact.items.filter((x) => seen.has(x.id) && !seen.get(x.id).ev);
compact.items = compact.items.filter((x) => !(seen.has(x.id) && !seen.get(x.id).ev));
const known = new Set(compact.items.map((x) => x.id));
const added = [...seen.values()].filter((s) => s.ev && !known.has(s.item.id)).map((s) => toCompact(s.item));
compact.items.push(...added);

const stamp = `${new Date().toISOString().slice(0, 10)}: import-yandex-har.js (${harPaths.map((p) => basename(p)).join(', ')}) - фильтр по рубрике "Станция зарядки электромобилей": −${removed.length} не-станций, +${added.length} новых`;
compact.source = compact.source.replace(/ \| \d{4}-\d{2}-\d{2}: import-yandex-har\.js.*$/, '') + ` | ${stamp}`;
compact.date = new Date().toISOString().slice(0, 10);
writeFileSync(COMPACT_PATH, JSON.stringify(compact, null, 1));

console.log(`уникальных записей в HAR: ${seen.size}, из них электрозаправок: ${[...seen.values()].filter((s) => s.ev).length}`);
console.log(`компактный файл: ${before} → ${compact.items.length} (удалено не-станций ${removed.length}, добавлено новых ${added.length})`);
if (removed.length) console.log('удалены, например:', removed.slice(0, 8).map((x) => x.title).join('; '));
if (added.length) console.log('добавлены:', added.map((x) => `${x.title} [${x.coordinates[1].toFixed(4)}, ${x.coordinates[0].toFixed(4)}]`).join('; '));
