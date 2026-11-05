// Excel export using the bundled SheetJS (no CDN). Loaded on first use.
import { t, getLang, itemText } from './i18n.js';
import { workspaceRows, safeCell } from './excel-rows.js';
import { fileSafe, todayLocal } from './util.js';
import { toast } from './dom.js';

let loading = null;
function loadXLSX() {
  if (globalThis.XLSX) return Promise.resolve(globalThis.XLSX);
  loading = loading || new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/xlsx.full.min.js';
    s.onload = () => res(globalThis.XLSX);
    s.onerror = () => rej(new Error('xlsx'));
    document.head.appendChild(s);
  });
  return loading;
}

function sheet(XLSX, rows, widths) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  if (widths) ws['!cols'] = widths.map((w) => ({ wch: w }));
  return ws;
}

export async function exportWorkspaceExcel(doc, { onlyMine = false } = {}) {
  try {
    const XLSX = await loadXLSX();
    const lang = getLang();
    const rows = workspaceRows(doc, { lang, itemText, statusLabel: (s) => t('status.' + s), onlyMine });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet(XLSX, rows, rows[0].map((h) => (/Work Step|Response|Evidence|Sample|Remediation Action|Comment/.test(h) ? 50 : 14))), 'CSA');
    const svc = doc.serviceType === 'full' ? 'Full' : 'Focus';
    XLSX.writeFile(wb, `CSA${doc.year}_${fileSafe(doc.hotelName)}_${svc}_${todayLocal().replace(/-/g, '')}.xlsx`);
  } catch { toast(t('err.excel')); }
}

// sheets: [{ name, rows }]
export async function exportSheets(name, sheets) {
  try {
    const XLSX = await loadXLSX();
    const wb = XLSX.utils.book_new();
    for (const s of sheets) XLSX.utils.book_append_sheet(wb, sheet(XLSX, s.rows.map((r) => r.map(safeCell))), s.name.slice(0, 31));
    XLSX.writeFile(wb, name);
  } catch { toast(t('err.excel')); }
}
