# Резерв мощности ТП 6-20/0,4 кВ филиала «Московские кабельные сети»
# (ПАО «Россети Московский регион», раскрытие информации rossetimr.ru/10,
# I квартал 2026): скан PDF на 232 страницы, распознан встроенным OCR macOS
# (Vision, scratchpad ocr.swift) в txt/NNN.txt - строки «x y w h<TAB>текст».
#
# Строка таблицы привязывается к ячейке «Городской округ» (она есть в каждой
# строке); остальные ячейки - к ближайшей такой строке по высоте.
# Колонки по x: район ~0.28-0.39, наименование ~0.39-0.58, пропускная
# способность ~0.58-0.67, резерв ~0.67-0.77, резерв с учётом договоров ~0.77+.
#
#   python3 scripts/parse-mks-reserve.py <папка txt> > data/tp-reserve.json
import json, re, sys, os, statistics

src = sys.argv[1]
num_re = re.compile(r'(\d+[,.]\d+)')

def fix_name(s):
    # OCR читает «П» как II, 11, I1, Пl ...: нормализуем префикс и номер
    s = s.replace('Т', 'T').replace('П', 'P')
    m = re.match(r'\s*(KT|PT|RT)?\s*T?\s*(P|II|11|I1|1I|Il|lI|ll)?\s*[I1l|]?\s*(\d{3,6})', s.replace('К', 'K'))
    kind = 'ТП'
    if re.match(r'\s*(РТП|PTP|RTP|PT[PI1])', s): kind = 'РТП'
    if re.match(r'\s*(КТП|KTP|KT)', s): kind = 'КТП'
    if re.match(r'\s*(РП|RP|PP|P[P1I]-?)\b', s) and not s.strip().startswith('T'): kind = 'РП'
    # номер - первая длинная серия цифр (кВ «6/0,4» идёт после номера)
    d = re.search(r'(\d{3,8})', s)
    if not d: return None, kind
    digits = d.group(1)
    # лишние «1» от буквы П (Т11..., ТП1...): номера МКС - не длиннее 5 цифр
    while len(digits) > 5 and digits[0] == '1': digits = digits[1:]
    if len(digits) > 5: digits = digits[-5:]
    return digits, kind

def clean_district(t):
    w = t.replace('(', ' ').split()
    while w and len(w[0]) <= 3 and len(w) > 1: w = w[1:]
    t = ' '.join(w)
    h = len(w) // 2
    if h and ' '.join(w[:h]).replace('ё', 'е') == ' '.join(w[h:]).replace('ё', 'е'): t = ' '.join(w[:h])
    return t

def to_f(t):
    m = num_re.search(t.replace(' ', ''))
    return float(m.group(1).replace(',', '.')) if m else None

rows = []
for fn in sorted(os.listdir(src)):
    boxes = []
    for line in open(os.path.join(src, fn), encoding='utf-8'):
        if '\t' not in line: continue
        a, t = line.rstrip('\n').split('\t', 1)
        x, y, w, h = map(float, a.split())
        boxes.append((x, y + h / 2, t))
    # OCR кусками с перекрытием: убрать повторы одной ячейки на стыке кусков
    uniq = []
    for b in sorted(boxes, key=lambda q: (q[1], q[0])):
        if any(abs(b[0] - u[0]) < 0.01 and abs(b[1] - u[1]) < 0.004 and b[2] == u[2] for u in uniq[-12:]): continue
        uniq.append(b)
    boxes = uniq
    anchors = sorted(y for x, y, t in boxes if 'ородской' in t and x < 0.2)
    if not anchors: continue
    cells = {a: {} for a in anchors}
    step = statistics.median([b - a for a, b in zip(anchors, anchors[1:])]) if len(anchors) > 2 else 0.01
    for x, y, t in boxes:
        if x < 0.27: continue
        a = min(anchors, key=lambda v: abs(v - y))
        if abs(a - y) > step * 0.6: continue
        col = 'district' if x < 0.385 else 'name' if x < 0.58 else 'cap' if x < 0.665 else 'res' if x < 0.765 else 'res2'
        cells[a][col] = (cells[a].get(col, '') + ' ' + t).strip()
    for a in anchors:
        c = cells[a]
        if 'name' not in c: continue
        num, kind = fix_name(c['name'])
        kv = re.search(r'(\d{1,2})/0[,.]4', c['name'])
        tr = re.search(r'(\d)\s*[xх×]\s*(\d[,.]\d{3})', c['name'])
        rows.append({
            'num': num, 'kind': kind, 'district': clean_district(c.get('district', '')),
            'kv': int(kv.group(1)) if kv else None,
            'trafo': f"{tr.group(1)}x{tr.group(2).replace(',', '.')}" if tr else None,
            'cap_MVA': to_f(c.get('cap', '')), 'res_MVA': to_f(c.get('res', '')), 'res_after_MVA': to_f(c.get('res2', '')),
            'raw': c['name'], 'page': int(fn[:3]),
        })

json.dump({
    'source': 'ПАО «Россети Московский регион», филиал «Московские кабельные сети»: информация о наличии свободной для технологического присоединения трансформаторной мощности по подстанциям и РП ниже 35 кВ, I квартал 2026 (rossetimr.ru/10, скачано 29.10.2026 с российского IP). Скан PDF распознан OCR - возможны ошибки в номерах и цифрах.',
    'date': '2026-10-29',
    'rows': rows,
}, sys.stdout, ensure_ascii=False)
print(f'строк {len(rows)}, с номером {sum(1 for r in rows if r["num"])}, с резервом {sum(1 for r in rows if r["res_after_MVA"] is not None)}', file=sys.stderr)
