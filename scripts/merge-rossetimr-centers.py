# Свободная мощность центров питания 35 кВ и выше по раскрытию ПАО «Россети
# Московский регион» (приложение 1 к приказу от 30.06.2026, III квартал 2026,
# scripts/data-sources/rossetimr-cp35-2026q3.pdf, скачано 29.10.2026 с
# российского IP). Резерв для техприсоединения, МВт, ставится центрам
# data/centers.json, которые совпали по названию (Москва; филиалы МВС, НМ).
# Центры без совпадения (ОЭК, МОЭСК-нет в списке, без названия в OSM)
# сохраняют оценку по классу напряжения.
#   python3 scripts/merge-rossetimr-centers.py
import json, re, subprocess, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF = os.path.join(ROOT, 'scripts', 'data-sources', 'rossetimr-cp35-2026q3.pdf')
txt = subprocess.run(['pdftotext', '-layout', PDF, '-'], capture_output=True, text=True).stdout
rows = []
for l in txt.splitlines():
    parts = [p.strip() for p in re.split(r'\s{2,}', l.strip()) if p.strip()]
    if len(parts) < 8 or not parts[0].isdigit() or not parts[1].startswith('ПС'): continue
    try:
        res = float(parts[-1].replace(',', '.')); load = float(parts[-2].replace(',', '.')); inst = float(parts[-3].replace(',', '.'))
    except ValueError:
        continue
    rows.append({'name': parts[1], 'owner': parts[2], 'region': parts[3], 'area': parts[4], 'kv': parts[5] if len(parts) > 8 else None, 'inst_MVA': inst, 'load_MVA': load, 'reserve_MW': res})
def norm(s):
    s = s.lower().replace('ё', 'е')
    s = re.sub(r'\bпс\b|подстанция|№\s*\d+|\d+(/\d+)*\s*кв|\(.*?\)|["«»]', ' ', s)
    s = re.sub(r'[^а-яa-z0-9\- ]', ' ', s)
    return ' '.join(s.split())
msk = {norm(r['name']): r for r in rows if r['region'] == 'Москва'}
path = os.path.join(ROOT, 'data', 'centers.json')
data = json.load(open(path, encoding='utf-8'))
hit = 0
for c in data['centers']:
    if not c.get('name'): continue
    r = msk.get(norm(c['name']))
    if not r: continue
    hit += 1
    c['reserve_estimate_MVA'] = c.get('reserve_estimate_MVA', c['reserve_MVA'])
    # МВт → МВА при cos φ 0,95 (как в модуле 5)
    c['reserve_MVA'] = round(max(0.0, r['reserve_MW']) / 0.95, 2)
    c['reserve_date'] = '2026-09-30'
    c['reserve_source'] = 'Россети Московский регион, раскрытие ЦП 35 кВ и выше, III кв. 2026'
    c['rossetimr'] = {'name': r['name'], 'inst_MVA': r['inst_MVA'], 'load_MVA': r['load_MVA'], 'reserve_MW': r['reserve_MW']}
note = ' | Резерв центров, совпавших по названию с раскрытием «Россети Московский регион» (ЦП 35 кВ и выше, III кв. 2026), - по раскрытию (scripts/merge-rossetimr-centers.py)'
if 'раскрытие' not in data['source']: data['source'] += note
json.dump(data, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
zero = sum(1 for c in data['centers'] if c.get('rossetimr') and c['rossetimr']['reserve_MW'] <= 0)
print(f'строк раскрытия {len(rows)}, по Москве {len(msk)}; центров модели с названием {sum(1 for c in data["centers"] if c.get("name"))}, совпало {hit}, из них без резерва {zero}')
