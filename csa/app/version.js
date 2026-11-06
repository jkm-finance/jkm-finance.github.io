// App and format versions. Bump APP_VERSION on every deploy (see CHANGELOG).
export const APP_ID = 'jkm-csa';
export const APP_VERSION = '0.4.2';
export const DOC_SCHEMA = 4;      // workspace document format (DATA_MODEL §5). 2 = item field `process`, 3 = per-item assignees, 4 = guidance notes moved into reviewer comments
export const FILE_SCHEMA = 3;     // exchanged file format (DATA_MODEL §9). 2 = may carry `process`, 3 = assignment.items; older apps must refuse
export const DB_VERSION = 1;      // IndexedDB structure version (stores are only ever added)
export const FILE_FORMAT = 'jkm-csa-file';
export const YEAR = 2026;
