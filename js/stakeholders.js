// Участники проекта для паспорта (предложение эксперта вуза 28.10): кто
// правообладатель площадки - по объекту OpenStreetMap в точке (Nominatim,
// extratags). Общие правила для scripts/assign-site-stakeholders.js и для
// произвольной точки в браузере. Это подсказка для переговоров, а не
// юридический факт: правообладателя подтверждает кадастровая карта.

const CITY_OPERATOR = /московский паркинг|ампп|администратор московского парковочного|гку|дептранс|автомобильные дороги/i;
const COMMERCIAL_KINDS = new Set(['ТЦ', 'бизнес-центр', 'гостиница', 'АЗС']);
const STREET_PARKING = new Set(['street_side', 'lane', 'on_kerb', 'half_on_kerb']);

// o - объект OSM в точке: {category, type, name, operator, fee, access, parking, residential, landuse}.
// kind - тип площадки из пула (если есть), siteName - её название.
export function ownerOf(o, { kind = null, siteName = null } = {}) {
  if (kind && COMMERCIAL_KINDS.has(kind)) return { kind: 'commercial', name: siteName || o?.name || null };
  if (!o) return { kind: 'unknown', name: null };
  if (o.operator && CITY_OPERATOR.test(o.operator)) return { kind: 'city', name: o.operator };
  if (o.type === 'parking' && STREET_PARKING.has(o.parking)) return { kind: 'city', name: 'улично-дорожная сеть' };
  if (o.type === 'parking' && o.fee === 'yes') return { kind: 'city', name: o.operator || 'платная парковка' };
  if (o.access === 'customers') return { kind: 'commercial', name: o.operator || o.name || null };
  if (o.residential || o.landuse === 'residential' || o.access === 'private') return { kind: 'residential', name: o.residential || o.name || null };
  if (['mall', 'supermarket', 'fuel', 'hotel', 'office', 'retail', 'commercial'].includes(o.type)) return { kind: 'commercial', name: o.name || o.operator || null };
  if (o.operator) return { kind: 'commercial', name: o.operator };
  if (o.type === 'parking' && o.access === 'yes') return { kind: 'public', name: o.name || null };
  return { kind: 'unknown', name: o.name || null };
}

// Кто договаривается о площадке и что для этого нужно - по типу правообладателя.
export const OWNER_TEXT = {
  city: {
    who: 'Город Москва',
    how: 'Городская земля: размещение через Дептранс по схеме ЭЗС или договор с ДГИ. Платные и уличные парковки — ГКУ «АМПП»; по программе АМПП подключение выполняет сетевая организация.',
  },
  residential: {
    who: 'Жильцы и управляющая компания',
    how: 'Парковка жилого квартала: решение общего собрания собственников или договор с УК / застройщиком. Срок согласования дольше, чем на городской и коммерческой земле.',
  },
  commercial: {
    who: 'Собственник объекта',
    how: 'Договор аренды мест с владельцем ТЦ, бизнес-центра, гостиницы или сетью АЗС. Станция приводит владельцу клиентов — возможна оплата процентом от выручки вместо аренды.',
  },
  public: {
    who: 'Город (по признакам)',
    how: 'Открытая бесплатная парковка, как правило, на городской земле. Правообладатель подтверждается по публичной кадастровой карте (nspd.gov.ru).',
  },
  unknown: {
    who: 'Уточняется',
    how: 'Правообладатель определяется по публичной кадастровой карте (nspd.gov.ru) по координатам точки.',
  },
};
