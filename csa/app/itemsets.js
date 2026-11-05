// Registry of built-in item sets (DATA_MODEL §3).
import full2026 from '../data/items_full.js';
import focus2026 from '../data/items_focus.js';

const SETS = {};
for (const s of [full2026, focus2026]) {
  s.byId = Object.fromEntries(s.items.map((i) => [i.id, i]));
  s.ids = s.items.map((i) => i.id);
  SETS[s.id] = s;
}

export function getItemSet(id) {
  return SETS[id] || null;
}

export function itemSetIdFor(serviceType, year) {
  const s = Object.values(SETS).find((x) => x.serviceType === serviceType && x.year === year);
  return s ? s.id : null;
}

export function allItemSets() {
  return Object.values(SETS);
}

// Test hook: register an extra (fake) item set, e.g. a 2027 set.
export function registerItemSet(s) {
  s.byId = Object.fromEntries(s.items.map((i) => [i.id, i]));
  s.ids = s.items.map((i) => i.id);
  SETS[s.id] = s;
}
