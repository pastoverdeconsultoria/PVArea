// Modelo de dados: pastas (com subpastas) e medições (polígono, linha, ponto).
// Funções puras sobre um objeto "db" para poderem ser testadas fora do app.

import { polygonArea, pathLength } from './geo.js';

export const DEFAULT_STYLE = {
  stroke: '#ffeb3b', strokeOpacity: 1, width: 3,
  fill: '#ffeb3b', fillOpacity: 0.25
};

// Ícones de ponto. "blue" é o bebedouro (gota invertida azul do Google Earth).
export const POINT_ICONS = {
  blue: { label: 'Bebedouro', color: '#3b78e7', href: 'http://maps.google.com/mapfiles/ms/icons/blue.png' },
  red: { label: 'Marcador', color: '#e53935', href: 'http://maps.google.com/mapfiles/ms/icons/red.png' },
  yellow: { label: 'Porteira', color: '#fdd835', href: 'http://maps.google.com/mapfiles/ms/icons/yellow.png' },
  green: { label: 'Cocho', color: '#43a047', href: 'http://maps.google.com/mapfiles/ms/icons/green.png' },
  orange: { label: 'Curral', color: '#fb8c00', href: 'http://maps.google.com/mapfiles/ms/icons/orange.png' },
  purple: { label: 'Sede', color: '#8e24aa', href: 'http://maps.google.com/mapfiles/ms/icons/purple.png' },
  pink: { label: 'Outro', color: '#ec407a', href: 'http://maps.google.com/mapfiles/ms/icons/pink.png' },
  ltblue: { label: 'Aguada/Represa', color: '#4fc3f7', href: 'http://maps.google.com/mapfiles/ms/icons/ltblue.png' }
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function emptyDb() {
  return {
    v: 1,
    folders: [],
    items: [],
    activeFolder: null,
    settings: {
      base: 'esri', googleKey: '', secondary: 'none', labels: 'name_area', showLabels: true,
      gpsMinDist: 3, gpsMaxAcc: 15, descArea: true, segLabels: true,
      lastStyle: { ...DEFAULT_STYLE }, lastIcon: 'blue', lastMethod: {},
      backupReminder: true, lastBackup: null, changedAt: null, remindedAt: null, created: null
    }
  };
}

export function normalizeDb(raw) {
  const db = emptyDb();
  if (!raw || typeof raw !== 'object') return db;
  db.folders = Array.isArray(raw.folders) ? raw.folders : [];
  db.items = Array.isArray(raw.items) ? raw.items : [];
  db.activeFolder = raw.activeFolder ?? null;
  db.settings = { ...db.settings, ...(raw.settings || {}) };
  db.settings.lastStyle = { ...DEFAULT_STYLE, ...(db.settings.lastStyle || {}) };
  if (!db.settings.created) db.settings.created = new Date().toISOString();
  // até a 1.0.3 "não mostrar" era um valor de labels; agora é a chave showLabels
  if (db.settings.labels === 'none') { db.settings.labels = 'name_area'; db.settings.showLabels = false; }
  if (db.settings.labels !== 'name') db.settings.labels = 'name_area';
  db.settings.showLabels = db.settings.showLabels !== false;
  const ids = new Set(db.folders.map(f => f.id));
  for (const f of db.folders) if (f.parentId && !ids.has(f.parentId)) f.parentId = null;
  for (const it of db.items) if (it.folderId && !ids.has(it.folderId)) it.folderId = null;
  if (db.activeFolder && !ids.has(db.activeFolder)) db.activeFolder = null;
  return db;
}

export function addFolder(db, name, parentId = null) {
  const f = { id: uid(), name: name.trim() || 'Nova pasta', parentId, open: true, visible: true };
  db.folders.push(f);
  return f;
}

export function childFolders(db, parentId) {
  return db.folders.filter(f => (f.parentId ?? null) === (parentId ?? null));
}

export function folderItems(db, folderId) {
  return db.items.filter(i => (i.folderId ?? null) === (folderId ?? null));
}

/** Ids da pasta e de todas as subpastas. */
export function descendantIds(db, folderId) {
  const out = [folderId];
  for (let i = 0; i < out.length; i++) {
    for (const f of db.folders) if (f.parentId === out[i]) out.push(f.id);
  }
  return out;
}

export function itemsDeep(db, folderId) {
  const ids = new Set(descendantIds(db, folderId));
  return db.items.filter(i => ids.has(i.folderId));
}

export function removeFolder(db, folderId) {
  const ids = new Set(descendantIds(db, folderId));
  db.items = db.items.filter(i => !ids.has(i.folderId));
  db.folders = db.folders.filter(f => !ids.has(f.id));
  if (ids.has(db.activeFolder)) db.activeFolder = null;
}

/** Mover pasta: não deixa mover para dentro dela mesma. */
export function canMoveFolder(db, folderId, newParentId) {
  if (!newParentId) return true;
  return !descendantIds(db, folderId).includes(newParentId);
}

export function folderPath(db, folderId) {
  const parts = [];
  let f = db.folders.find(x => x.id === folderId);
  let guard = 0;
  while (f && guard++ < 50) {
    parts.unshift(f.name);
    f = db.folders.find(x => x.id === f.parentId);
  }
  return parts.join(' / ');
}

/** Lista plana das pastas em ordem de árvore, com nível de indentação. */
export function folderList(db, parentId = null, depth = 0, out = []) {
  for (const f of childFolders(db, parentId)) {
    out.push({ folder: f, depth });
    folderList(db, f.id, depth + 1, out);
  }
  return out;
}

export function itemArea(it) {
  return it.type === 'polygon' ? polygonArea(it.coords, it.holes || []) : 0;
}

export function itemLength(it) {
  if (it.type === 'polygon') {
    let d = pathLength(it.coords, true);
    for (const h of it.holes || []) d += pathLength(h, true);
    return d;
  }
  if (it.type === 'line') return pathLength(it.coords, false);
  return 0;
}

export function folderTotals(db, folderId) {
  const items = folderId === null ? db.items : itemsDeep(db, folderId);
  let area = 0, count = 0;
  for (const it of items) { area += itemArea(it); count++; }
  return { area, count };
}

/** Um item só aparece se ele e todas as pastas acima estiverem visíveis. */
export function isVisible(db, it) {
  if (it.visible === false) return false;
  let f = db.folders.find(x => x.id === it.folderId);
  let guard = 0;
  while (f && guard++ < 50) {
    if (f.visible === false) return false;
    f = db.folders.find(x => x.id === f.parentId);
  }
  return true;
}

/**
 * Monta a árvore para exportar.
 * folderId = id de uma pasta (exporta ela com tudo dentro) ou null (exporta tudo).
 */
export function exportTree(db, folderId, rootName = 'PV Área') {
  const build = f => ({
    name: f.name,
    folders: childFolders(db, f.id).map(build),
    items: folderItems(db, f.id)
  });
  if (folderId) {
    const f = db.folders.find(x => x.id === folderId);
    if (!f) return null;
    return { name: f.name, folders: [build(f)], items: [] };
  }
  return { name: rootName, folders: childFolders(db, null).map(build), items: folderItems(db, null) };
}

/** Insere no db uma árvore importada ({name, folders, items}) e devolve a pasta criada. */
export function importTree(db, tree, parentId = null) {
  const f = addFolder(db, tree.name || 'Importado', parentId);
  for (const it of tree.items || []) {
    db.items.push({ ...it, id: uid(), folderId: f.id, visible: true });
  }
  for (const sub of tree.folders || []) importTree(db, sub, f.id);
  return f;
}

export function safeFileName(name) {
  const s = (name || 'pv-area').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 _.-]/g, '').trim().replace(/\s+/g, '_');
  return s || 'pv-area';
}

// ------------------------------------------------------------------ backup

export const BACKUP_VERSION = 1;
const DAY_MS = 86400000;

function validCoord(c) {
  return Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[0]) <= 90 && Math.abs(c[1]) <= 180;
}

/** Mantém só medições com geometria válida; devolve também quantas foram descartadas. */
export function sanitizeItems(items) {
  const out = [];
  let skipped = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const min = it && (it.type === 'polygon' ? 3 : it.type === 'line' ? 2 : it.type === 'point' ? 1 : 0);
    if (min && Array.isArray(it.coords) && it.coords.length >= min && it.coords.every(validCoord)) {
      out.push({ ...it, id: it.id || uid(), name: String(it.name ?? 'Medição') });
    } else skipped++;
  }
  return { items: out, skipped };
}

export function backupFileName(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `PVArea-backup-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.json`;
}

/** Objeto do backup. Fica de fora a chave do Google e os controles internos de backup. */
export function makeBackup(db, now = new Date()) {
  const settings = { ...db.settings };
  for (const k of ['googleKey', 'lastBackup', 'changedAt', 'remindedAt', 'created']) delete settings[k];
  return {
    app: 'PVArea', version: BACKUP_VERSION, createdAt: now.toISOString(),
    activeFolder: db.activeFolder, settings, folders: db.folders, items: db.items
  };
}

export function parseBackup(text) {
  let o;
  try { o = JSON.parse(text); } catch { throw new Error('Arquivo de backup inválido'); }
  if (!o || o.app !== 'PVArea' || !Array.isArray(o.folders) || !Array.isArray(o.items)) {
    throw new Error('Este arquivo não é um backup do PV Área');
  }
  if (o.version > BACKUP_VERSION) throw new Error('Backup de uma versão mais nova do app. Atualize o app e tente de novo.');
  const { items, skipped } = sanitizeItems(o.items);
  const folders = o.folders.filter(f => f && f.id).map(f => ({
    id: f.id, name: String(f.name || 'Pasta'), parentId: f.parentId ?? null, open: f.open !== false, visible: f.visible !== false
  }));
  return { ...o, folders, items, skipped };
}

/** Banco novo igual ao backup, mantendo a chave do Google e os controles de backup do aparelho. */
export function restoreBackup(db, backup) {
  const nd = normalizeDb({ folders: backup.folders, items: backup.items, activeFolder: backup.activeFolder, settings: backup.settings });
  for (const k of ['googleKey', 'lastBackup', 'created']) nd.settings[k] = db.settings[k];
  nd.settings.changedAt = new Date().toISOString();
  return nd;
}

/** Traz do backup o que ainda não existe no banco (por id). O que já existe fica como está. */
export function mergeBackup(db, backup) {
  const fIds = new Set(db.folders.map(f => f.id));
  const iIds = new Set(db.items.map(i => i.id));
  let nf = 0, ni = 0;
  for (const f of backup.folders) {
    if (!fIds.has(f.id)) { db.folders.push({ ...f }); fIds.add(f.id); nf++; }
  }
  for (const it of backup.items) {
    if (!iIds.has(it.id)) { db.items.push({ ...it }); iIds.add(it.id); ni++; }
  }
  for (const f of db.folders) if (f.parentId && !fIds.has(f.parentId)) f.parentId = null;
  for (const it of db.items) if (it.folderId && !fIds.has(it.folderId)) it.folderId = null;
  return { folders: nf, items: ni };
}

/** Passaram 7 dias desde o último backup (ou desde o primeiro uso) e há alteração não salva? */
export function backupDue(db, now = new Date()) {
  const s = db.settings;
  if (!s.backupReminder || !db.items.length) return false;
  const t = now.getTime();
  const base = new Date(s.lastBackup || s.created || now).getTime();
  const changed = s.changedAt ? new Date(s.changedAt).getTime() : 0;
  if (s.lastBackup && changed <= base) return false;
  if (t - base < 7 * DAY_MS) return false;
  if (s.remindedAt && t - new Date(s.remindedAt).getTime() < DAY_MS) return false;
  return true;
}
