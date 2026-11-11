import 'leaflet/dist/leaflet.css';
import './style.css';
import L from 'leaflet';
import JSZip from 'jszip';
import {
  DEFAULT_STYLE, POINT_ICONS, uid, emptyDb, normalizeDb, addFolder, removeFolder, childFolders, folderItems,
  descendantIds, itemsDeep, folderTotals, folderList, folderPath, canMoveFolder, isVisible, itemArea, itemLength,
  exportTree, importTree, safeFileName
} from './model.js';
import { polygonArea, pathLength, distance, labelPoint, bounds, fmtArea, fmtDist, SECONDARY_UNITS } from './geo.js';
import { buildKml, parseKml, countTree, esc } from './kml.js';
import { isNative, loadDb, saveDb, shareFile, saveToDocuments, watchGps, keepAwake, onBackButton } from './platform.js';
import { BASES, baseLayers, cachedTileCount, clearTileCache } from './tiles.js';

const $ = id => document.getElementById(id);
const DRAFT_KEY = 'pvarea.draft.v1';
const PALETTE = ['#ffeb3b', '#ff9800', '#f44336', '#e91e63', '#9c27b0', '#2196f3', '#00bcd4', '#4caf50', '#8bc34a', '#ffffff', '#000000', '#795548'];

let db = emptyDb();
let map, baseGroup, itemGroup, drawGroup;
let draw = null;          // medição em andamento
let gps = { stop: null, fix: null, marker: null, circle: null, wanted: false };
let sheetOnClose = null;
let modalResolve = null;

// ------------------------------------------------------------------ utilidades

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function persist() {
  if (!saveDb(db)) toast('Não foi possível gravar no celular (armazenamento cheio?)', 5000);
}

function sec() { return db.settings.secondary; }

function pinSvg(color) {
  return `<svg viewBox="0 0 26 36"><path d="M13 35C13 35 2 20.500 2 12.500a11 11 0 0 1 22 0C24 20.500 13 35 13 35Z" fill="${color}" stroke="#fff" stroke-width="1.500"/><circle cx="13" cy="12.500" r="4" fill="#fff" fill-opacity=".9"/></svg>`;
}

const EYE = '<svg viewBox="0 0 24 24"><path d="M12 5C6.500 5 2.700 9.100 1.500 12c1.200 2.900 5 7 10.500 7s9.300-4.100 10.500-7C21.300 9.100 17.500 5 12 5Zm0 11.500A4.500 4.500 0 1 1 12 7.500a4.500 4.500 0 0 1 0 9Zm0-2.500a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/></svg>';

// ------------------------------------------------------------------ folha e modal

function openSheet(html, { full = false, onClose = null } = {}) {
  const body = $('sheetBody');
  body.className = 'sheet' + (full ? ' full' : '');
  body.innerHTML = html;
  $('sheet').classList.add('open');
  sheetOnClose = onClose;
  body.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeSheet()));
  return body;
}

function closeSheet(runCallback = true) {
  if (!$('sheet').classList.contains('open')) return;
  $('sheet').classList.remove('open');
  $('sheetBody').innerHTML = '';
  const cb = sheetOnClose;
  sheetOnClose = null;
  if (runCallback && cb) cb();
}

function head(title) {
  return `<div class="sheet-head"><h2>${esc(title)}</h2><button class="x" data-close type="button" aria-label="Fechar">×</button></div>`;
}

function modal(html) {
  return new Promise(resolve => {
    $('modalBody').innerHTML = html;
    $('modal').classList.add('open');
    modalResolve = resolve;
  });
}

function closeModal(value) {
  $('modal').classList.remove('open');
  $('modalBody').innerHTML = '';
  const r = modalResolve;
  modalResolve = null;
  if (r) r(value);
}

function askConfirm(title, text, okLabel = 'Confirmar', danger = false) {
  const p = modal(`<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="row">
    <button class="btn" id="mNo" type="button">Cancelar</button>
    <button class="btn ${danger ? 'danger' : 'primary'}" id="mYes" type="button">${esc(okLabel)}</button></div>`);
  $('mNo').onclick = () => closeModal(false);
  $('mYes').onclick = () => closeModal(true);
  return p;
}

function askText(title, value = '', okLabel = 'Salvar') {
  const p = modal(`<h3>${esc(title)}</h3><input class="in" id="mTxt" maxlength="80" value="${esc(value)}"><div class="row">
    <button class="btn" id="mNo" type="button">Cancelar</button>
    <button class="btn primary" id="mYes" type="button">${esc(okLabel)}</button></div>`);
  const inp = $('mTxt');
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
  const ok = () => closeModal(inp.value.trim() || null);
  $('mNo').onclick = () => closeModal(null);
  $('mYes').onclick = ok;
  inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
  return p;
}

// ------------------------------------------------------------------ mapa

async function setBase() {
  baseGroup.clearLayers();
  let layers;
  try {
    layers = await baseLayers(db.settings.base, db.settings.googleKey);
  } catch (e) {
    toast(String(e.message || e) + '. Usando a imagem da Esri.', 5000);
    layers = await baseLayers('esri', '');
  }
  const mz = Number(db.settings.maxNativeZoom) || 18;
  for (const l of layers) {
    if (db.settings.base.startsWith('esri')) l.options.maxNativeZoom = mz;
    baseGroup.addLayer(l);
  }
}

function leafletStyle(it) {
  const s = { ...DEFAULT_STYLE, ...(it.style || {}) };
  return {
    color: s.stroke, opacity: s.strokeOpacity, weight: s.width,
    fillColor: s.fill, fillOpacity: it.type === 'polygon' ? s.fillOpacity : 0, fill: it.type === 'polygon',
    lineJoin: 'round'
  };
}

function labelHtml(it) {
  const mode = db.settings.labels;
  if (mode === 'none') return '';
  let h = esc(it.name);
  if (mode === 'name_area') {
    if (it.type === 'polygon') h += `<br><small>${esc(fmtArea(itemArea(it), 'none'))}</small>`;
    else if (it.type === 'line') h += `<br><small>${esc(fmtDist(itemLength(it)))}</small>`;
  }
  return h;
}

function renderItems() {
  itemGroup.clearLayers();
  const editingId = draw && draw.editingId;
  for (const it of db.items) {
    if (it.id === editingId || !isVisible(db, it)) continue;
    let layer, anchor;
    if (it.type === 'polygon') {
      layer = L.polygon([it.coords, ...(it.holes || [])], leafletStyle(it));
      anchor = labelPoint(it.coords);
    } else if (it.type === 'line') {
      layer = L.polyline(it.coords, leafletStyle(it));
      const k = Math.floor((it.coords.length - 1) / 2);
      const p1 = it.coords[k], p2 = it.coords[k + 1] || p1;
      anchor = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
    } else {
      const ic = POINT_ICONS[it.icon] || POINT_ICONS.red;
      layer = L.marker(it.coords[0], {
        icon: L.divIcon({ className: 'pin', html: pinSvg(ic.color), iconSize: [26, 36], iconAnchor: [13, 35] })
      });
    }
    layer.on('click', e => {
      if (draw) return;
      L.DomEvent.stopPropagation(e);
      openItemSheet(it.id);
    });
    itemGroup.addLayer(layer);
    const html = labelHtml(it);
    if (html) {
      if (it.type === 'point') {
        layer.bindTooltip(html, { permanent: true, direction: 'bottom', className: 'lbl', offset: [0, 2] });
      } else if (anchor) {
        const tip = L.tooltip({ permanent: true, direction: 'center', className: 'lbl', interactive: false })
          .setLatLng(anchor).setContent(html);
        itemGroup.addLayer(tip);
      }
    }
  }
  updateChip();
}

function updateChip() {
  const f = db.folders.find(x => x.id === db.activeFolder);
  $('btnFolder').textContent = '📁 ' + (f ? f.name : 'Sem pasta ativa');
}

function fitTo(coordsList) {
  const b = bounds(coordsList);
  if (!b) return;
  if (b[0][0] === b[1][0] && b[0][1] === b[1][1]) map.setView(b[0], 17);
  else map.fitBounds(b, { padding: [40, 90], maxZoom: 18 });
}

function allCoords(items) {
  const out = [];
  for (const it of items) for (const c of it.coords) out.push(c);
  return out;
}

// ------------------------------------------------------------------ GPS

async function startGps() {
  if (gps.stop) return;
  gps.wanted = true;
  gps.stop = await watchGps(onFix, msg => { gps.fix = null; gps.err = msg; updateHud(); if (!draw) toast(msg); });
}

function stopGps() {
  if (gps.stop) gps.stop();
  gps = { stop: null, fix: null, marker: null, circle: null, wanted: false };
  if (gpsLayer) gpsLayer.clearLayers();
  $('btnLocate').classList.remove('on');
}

let gpsLayer = null;
let followOnce = false;

function onFix(fix) {
  gps.fix = fix;
  gps.err = null;
  const ll = [fix.lat, fix.lng];
  if (!gps.marker) {
    gps.circle = L.circle(ll, { radius: fix.acc || 1, color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(gpsLayer);
    gps.marker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="gpsdot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false, keyboard: false }).addTo(gpsLayer);
  } else {
    gps.marker.setLatLng(ll);
    gps.circle.setLatLng(ll).setRadius(fix.acc || 1);
  }
  if (followOnce) { followOnce = false; map.setView(ll, Math.max(map.getZoom(), 17)); }
  if (draw && draw.recording) recordFix(fix);
  updateHud();
}

function recordFix(fix) {
  if (fix.acc > db.settings.gpsMaxAcc) return;
  const p = [fix.lat, fix.lng];
  const last = draw.coords[draw.coords.length - 1];
  if (last && distance(last, p) < db.settings.gpsMinDist) return;
  draw.coords.push(p);
  draw.undo.push('gps');
  saveDraft();
  redrawDraw(false);
  if (!map.getBounds().pad(-0.15).contains(p)) map.panTo(p);
}

// ------------------------------------------------------------------ desenho

/** Pergunta como medir: Manual, ou GPS (percorrer / marcar ponto). Devolve 'manual' | 'gps-walk' | 'gps-mark' ou null. */
function pick(html) {
  const p = modal(html);
  $('modalBody').querySelectorAll('[data-v]').forEach(b => { b.onclick = () => closeModal(b.dataset.v); });
  return p;
}

async function chooseMethod(type) {
  const last = (db.settings.lastMethod || {})[type] || 'manual';
  const noun = type === 'point' ? 'o ponto' : type === 'line' ? 'a distância' : 'a área';
  const remember = m => { db.settings.lastMethod = { ...(db.settings.lastMethod || {}), [type]: m }; persist(); return m; };
  for (;;) {
    const src = await pick(`<h3>Medir ${noun}</h3><div class="menu">
      <button class="btn${last === 'manual' ? ' primary' : ''}" data-v="manual" type="button"><b>Manual</b><span class="sub">Toque no mapa para marcar os pontos</span></button>
      <button class="btn${last !== 'manual' ? ' primary' : ''}" data-v="gps" type="button"><b>GPS</b><span class="sub">${type === 'point' ? 'Usar a posição do celular' : 'Usar a posição do celular'}</span></button>
      <button class="btn" data-v="" type="button">Cancelar</button></div>`);
    if (!src) return null;
    if (src === 'manual') return remember('manual');
    if (type === 'point') return remember('gps-mark');
    const g = await pick(`<h3>GPS: como medir?</h3><div class="menu">
      <button class="btn${last !== 'gps-mark' ? ' primary' : ''}" data-v="walk" type="button"><b>Percorrer</b><span class="sub">Caminhe pelo contorno e o app grava os pontos sozinho</span></button>
      <button class="btn${last === 'gps-mark' ? ' primary' : ''}" data-v="mark" type="button"><b>Marcar ponto</b><span class="sub">Vá até cada canto e toque para marcar onde você está</span></button>
      <button class="btn" data-v="back" type="button">Voltar</button></div>`);
    if (g === null || g === '') return null;
    if (g === 'back') continue;
    return remember(g === 'walk' ? 'gps-walk' : 'gps-mark');
  }
}

async function startMeasure(type) {
  const mode = await chooseMethod(type);
  if (!mode) return;
  startDraw(type, null, mode);
}

async function changeMode() {
  if (!draw) return;
  const d = draw;
  const mode = await chooseMethod(d.type);
  if (!mode || draw !== d) return;
  enterMode(mode, false);
}

function startRecording() {
  if (!draw || draw.recording) return;
  draw.recording = true;
  keepAwake(true);
  if (gps.fix) recordFix(gps.fix);
  renderBottom();
  redrawDraw(true);
}

function stopRecording() {
  if (!draw || !draw.recording) return;
  draw.recording = false;
  keepAwake(false);
  renderBottom();
  redrawDraw(true);
}

async function enterMode(mode, hint = true) {
  if (!draw) return;
  const d = draw;
  d.mode = mode;
  if (d.recording && mode !== 'gps-walk') stopRecording();
  renderBottom();
  redrawDraw(true);
  if (mode === 'manual') {
    if (hint && !d.editingId) toast(d.type === 'point' ? 'Toque no mapa para posicionar o ponto' : 'Toque no mapa para marcar os pontos');
    return;
  }
  if (!gps.stop) { followOnce = true; await startGps(); $('btnLocate').classList.add('on'); }
  if (draw !== d || d.mode !== mode) return;
  if (mode === 'gps-walk') {
    startRecording();
    toast('Caminhe pelo contorno. Mantenha a tela ligada.', 4000);
  } else if (hint) {
    toast(d.type === 'point' ? 'Toque em "Usar posição" quando estiver no local' : 'Vá até o canto e toque em "Marcar ponto"', 4000);
  }
}

function startDraw(type, existing = null, mode = 'manual') {
  closeSheet(false);
  draw = {
    type,
    mode: 'manual',
    coords: existing ? existing.coords.map(c => [c[0], c[1]]) : [],
    holes: existing && existing.holes ? existing.holes : null,
    editingId: existing ? existing.id : null,
    recording: false,
    undo: []
  };
  map.doubleClickZoom.disable();
  renderItems();
  renderBottom();
  redrawDraw(true);
  if (existing) fitTo(existing.coords);
  enterMode(mode, !existing);
}

function drawStyle() {
  const base = draw.editingId ? (db.items.find(i => i.id === draw.editingId) || {}).style : db.settings.lastStyle;
  return { ...DEFAULT_STYLE, ...(base || {}) };
}

function saveDraft() {
  if (!draw || draw.editingId || draw.type === 'point') return;
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ type: draw.type, coords: draw.coords })); } catch { /* sem espaço */ }
}
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch { /* nada */ } }

function redrawDraw(withHandles) {
  if (!draw) return;
  const s = drawStyle();
  if (!draw.shape) {
    drawGroup.clearLayers();
    draw.handles = L.layerGroup().addTo(drawGroup);
    if (draw.type === 'polygon') {
      draw.shape = L.polygon([], { color: s.stroke, weight: s.width, opacity: 1, fillColor: s.fill, fillOpacity: Math.max(0.15, s.fillOpacity), interactive: false }).addTo(drawGroup);
    } else if (draw.type === 'line') {
      draw.shape = L.polyline([], { color: s.stroke, weight: s.width, opacity: 1, interactive: false }).addTo(drawGroup);
    } else {
      draw.shape = L.layerGroup().addTo(drawGroup);
    }
  }
  if (draw.type === 'polygon') draw.shape.setLatLngs([draw.coords, ...(draw.holes || [])]);
  else if (draw.type === 'line') draw.shape.setLatLngs(draw.coords);
  if (withHandles) rebuildHandles();
  updateHud();
  const done = $('bbDone'), undo = $('bbUndo');
  if (done) done.disabled = !canFinish();
  if (undo) undo.disabled = !draw.coords.length;
}

function canFinish() {
  const n = draw.coords.length;
  return draw.type === 'polygon' ? n >= 3 : draw.type === 'line' ? n >= 2 : n >= 1;
}

function rebuildHandles() {
  draw.handles.clearLayers();
  if (draw.recording) return;
  const n = draw.coords.length;
  if (draw.type === 'point') {
    if (!n) return;
    const ic = POINT_ICONS[draw.icon || db.settings.lastIcon] || POINT_ICONS.blue;
    const m = L.marker(draw.coords[0], {
      draggable: true,
      icon: L.divIcon({ className: 'pin', html: pinSvg(ic.color), iconSize: [26, 36], iconAnchor: [13, 35] })
    }).addTo(draw.handles);
    m.on('drag', () => { const p = m.getLatLng(); draw.coords[0] = [p.lat, p.lng]; });
    return;
  }
  if (n > 400) { toast('Muitos pontos: os marcadores de ajuste ficam ocultos', 3500); return; }
  const closed = draw.type === 'polygon';
  draw.coords.forEach((c, i) => {
    const m = L.marker(c, {
      draggable: true, zIndexOffset: 500,
      icon: L.divIcon({ className: '', html: `<div class="vh${i === 0 ? ' first' : ''}"></div>`, iconSize: [26, 26], iconAnchor: [13, 13] })
    }).addTo(draw.handles);
    m.on('drag', () => { const p = m.getLatLng(); draw.coords[i] = [p.lat, p.lng]; redrawDraw(false); });
    m.on('dragend', () => { draw.undo.push('move'); saveDraft(); rebuildHandles(); });
    m.on('click', () => vertexMenu(i));
  });
  const segs = closed ? n : n - 1;
  if (n < 2) return;
  for (let i = 0; i < segs; i++) {
    const a = draw.coords[i], b = draw.coords[(i + 1) % n];
    if (n === 2 && i === 1) break;
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const m = L.marker(mid, {
      draggable: true,
      icon: L.divIcon({ className: '', html: '<div class="mh"></div>', iconSize: [18, 18], iconAnchor: [9, 9] })
    }).addTo(draw.handles);
    if (db.settings.segLabels && n <= 80) {
      m.bindTooltip(fmtDist(distance(a, b)), { permanent: true, direction: 'top', className: 'seglbl', offset: [0, -6] });
    }
    m.on('dragstart', () => { draw.coords.splice(i + 1, 0, mid.slice()); m.unbindTooltip(); });
    m.on('drag', () => { const p = m.getLatLng(); draw.coords[i + 1] = [p.lat, p.lng]; redrawDraw(false); });
    m.on('dragend', () => { draw.undo.push('ins'); saveDraft(); rebuildHandles(); });
  }
}

async function vertexMenu(i) {
  const min = draw.type === 'polygon' ? 3 : 2;
  if (draw.coords.length <= min && draw.editingId) { toast('Não dá para remover: é o mínimo de pontos'); return; }
  const ok = await askConfirm(`Ponto ${i + 1}`, 'Remover este ponto da medição?', 'Remover', true);
  if (!ok || !draw) return;
  draw.coords.splice(i, 1);
  saveDraft();
  redrawDraw(true);
}

function addPoint(p) {
  if (draw.type === 'point') draw.coords = [p];
  else { draw.coords.push(p); draw.undo.push('add'); }
  saveDraft();
  redrawDraw(true);
}

function undoPoint() {
  if (!draw || !draw.coords.length) return;
  draw.coords.pop();
  saveDraft();
  redrawDraw(true);
}

function updateHud() {
  const hud = $('hud');
  if (!draw) { hud.classList.add('hidden'); hud._last = null; $('btnFolder').classList.remove('hidden'); return; }
  $('btnFolder').classList.add('hidden');
  hud.classList.remove('hidden');
  let h = '';
  const n = draw.coords.length;
  if (draw.type === 'polygon') {
    h = `<div class="big">${esc(fmtArea(n >= 3 ? polygonArea(draw.coords, draw.holes || []) : 0, sec()))}</div>` +
      `<div class="sub">Perímetro ${esc(fmtDist(pathLength(draw.coords, true)))} · ${n} pontos</div>`;
  } else if (draw.type === 'line') {
    h = `<div class="big">${esc(fmtDist(pathLength(draw.coords, false)))}</div><div class="sub">${n} pontos</div>`;
  } else {
    h = `<div class="big">Ponto</div><div class="sub">${n ? draw.coords[0][0].toFixed(6) + ', ' + draw.coords[0][1].toFixed(6) : 'toque no mapa ou use o GPS'}</div>`;
  }
  if (gps.wanted) {
    if (gps.fix) {
      const bad = gps.fix.acc > db.settings.gpsMaxAcc;
      h += `<div class="gps${bad ? ' bad' : ''}">GPS ±${Math.round(gps.fix.acc)} m${bad ? ' — fraco, aguardando melhorar' : ''}${draw.recording ? ' · gravando' : ''}</div>`;
    } else {
      h += `<div class="gps bad">${esc(gps.err || 'Procurando sinal de GPS…')}</div>`;
    }
  }
  const modeTxt = { manual: 'Manual · toque no mapa', 'gps-walk': 'GPS · percorrer', 'gps-mark': 'GPS · marcar ponto' }[draw.mode];
  h += `<button class="modebtn" data-mode type="button">${modeTxt} ▾</button>`;
  if (hud._last !== h) { hud._last = h; hud.innerHTML = h; }
}

async function gpsPoint() {
  if (!gps.stop) { followOnce = true; await startGps(); $('btnLocate').classList.add('on'); }
  if (!gps.fix) { toast('Aguardando o GPS… toque de novo quando aparecer a precisão'); updateHud(); return; }
  if (gps.fix.acc > db.settings.gpsMaxAcc) {
    const ok = await askConfirm('GPS fraco', `A precisão agora é de ±${Math.round(gps.fix.acc)} m. Marcar o ponto mesmo assim?`, 'Marcar');
    if (!ok || !draw) return;
  }
  addPoint([gps.fix.lat, gps.fix.lng]);
  map.panTo([gps.fix.lat, gps.fix.lng]);
}

function toggleRecord() {
  if (!draw) return;
  if (draw.recording) stopRecording(); else startRecording();
}

async function cancelDraw() {
  if (!draw) return;
  if (draw.coords.length > 1) {
    const ok = await askConfirm('Descartar', draw.editingId ? 'Descartar as alterações desta forma?' : 'Descartar esta medição?', 'Descartar', true);
    if (!ok) return;
  }
  endDraw();
}

function endDraw() {
  keepAwake(false);
  draw = null;
  map.doubleClickZoom.enable();
  clearDraft();
  drawGroup.clearLayers();
  renderItems();
  renderBottom();
  updateHud();
}

function finishDraw() {
  if (!draw || !canFinish()) return;
  if (draw.recording) { draw.recording = false; keepAwake(false); }
  if (draw.editingId) {
    const it = db.items.find(i => i.id === draw.editingId);
    if (it) { it.coords = draw.coords; persist(); }
    const id = draw.editingId;
    endDraw();
    toast('Forma atualizada');
    openItemSheet(id);
    return;
  }
  const count = db.items.filter(i => i.type === draw.type).length + 1;
  const item = {
    id: uid(), folderId: db.activeFolder, type: draw.type,
    name: (draw.type === 'polygon' ? 'Área ' : draw.type === 'line' ? 'Linha ' : 'Bebedouro ') + count,
    desc: '', coords: draw.coords, visible: true
  };
  if (draw.type === 'point') {
    item.icon = db.settings.lastIcon;
    item.name = (POINT_ICONS[item.icon] || POINT_ICONS.red).label + ' ' + count;
  } else {
    item.style = { ...DEFAULT_STYLE, ...db.settings.lastStyle };
  }
  openItemSheet(null, item);
}

// ------------------------------------------------------------------ editor de estilo

function styleEditorHtml(type) {
  const sw = (grp) => PALETTE.map(c => `<button type="button" class="sw" data-grp="${grp}" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join('') +
    `<label class="sw-custom" aria-label="Outra cor"><input type="color" data-grp="${grp}"></label>`;
  let h = `<div class="preview"><svg viewBox="0 0 200 78" id="stPrev"></svg></div>
    <label class="f">Cor do contorno</label><div class="swatches">${sw('stroke')}</div>
    <label class="f">Espessura do contorno</label>
    <div class="slider"><input type="range" id="stW" min="1" max="10" step="0.5"><output id="stWo"></output></div>
    <label class="f">Transparência do contorno</label>
    <div class="slider"><input type="range" id="stSo" min="0" max="100" step="5"><output id="stSoo"></output></div>`;
  if (type === 'polygon') {
    h += `<label class="f">Cor do preenchimento</label><div class="swatches">${sw('fill')}</div>
    <label class="f">Transparência do preenchimento</label>
    <div class="slider"><input type="range" id="stFo" min="0" max="100" step="5"><output id="stFoo"></output></div>
    <p class="hint">0% = cor sólida · 100% = só o contorno</p>`;
  }
  return h;
}

/** Liga os controles do editor a um objeto de estilo (alterado no lugar). */
function bindStyleEditor(root, style, type, onChange = () => {}) {
  const q = s => root.querySelector(s);
  const refresh = () => {
    root.querySelectorAll('.sw').forEach(b => b.classList.toggle('sel', b.dataset.c.toLowerCase() === String(style[b.dataset.grp]).toLowerCase()));
    root.querySelectorAll('input[type=color]').forEach(i => { i.value = style[i.dataset.grp]; });
    q('#stW').value = style.width; q('#stWo').textContent = String(style.width).replace('.', ',') + ' px';
    const so = Math.round((1 - style.strokeOpacity) * 100);
    q('#stSo').value = so; q('#stSoo').textContent = so + '%';
    if (type === 'polygon') {
      const fo = Math.round((1 - style.fillOpacity) * 100);
      q('#stFo').value = fo; q('#stFoo').textContent = fo + '%';
    }
    const shape = type === 'polygon'
      ? `<polygon points="14,62 40,10 120,4 188,30 170,70 70,74" fill="${style.fill}" fill-opacity="${style.fillOpacity}" stroke="${style.stroke}" stroke-opacity="${style.strokeOpacity}" stroke-width="${style.width}" stroke-linejoin="round"/>`
      : `<polyline points="10,64 50,14 110,52 190,10" fill="none" stroke="${style.stroke}" stroke-opacity="${style.strokeOpacity}" stroke-width="${style.width}" stroke-linejoin="round" stroke-linecap="round"/>`;
    q('#stPrev').innerHTML = shape;
    onChange();
  };
  root.querySelectorAll('.sw').forEach(b => b.addEventListener('click', () => { style[b.dataset.grp] = b.dataset.c; refresh(); }));
  root.querySelectorAll('input[type=color]').forEach(i => i.addEventListener('input', () => { style[i.dataset.grp] = i.value; refresh(); }));
  q('#stW').addEventListener('input', e => { style.width = Number(e.target.value); refresh(); });
  q('#stSo').addEventListener('input', e => { style.strokeOpacity = Math.round(100 - Number(e.target.value)) / 100; refresh(); });
  if (type === 'polygon') q('#stFo').addEventListener('input', e => { style.fillOpacity = Math.round(100 - Number(e.target.value)) / 100; refresh(); });
  refresh();
}

function folderOptions(selected, excludeTree = null) {
  const blocked = excludeTree ? new Set(descendantIds(db, excludeTree)) : new Set();
  let h = `<option value=""${!selected ? ' selected' : ''}>(sem pasta)</option>`;
  for (const { folder, depth } of folderList(db)) {
    if (blocked.has(folder.id)) continue;
    h += `<option value="${folder.id}"${folder.id === selected ? ' selected' : ''}>${'  '.repeat(depth)}${esc(folder.name)}</option>`;
  }
  return h;
}

// ------------------------------------------------------------------ medição (item)

function openItemSheet(id, fresh = null) {
  const isNew = !!fresh;
  const orig = isNew ? fresh : db.items.find(i => i.id === id);
  if (!orig) return;
  const it = JSON.parse(JSON.stringify(orig));
  if (it.type !== 'point') it.style = { ...DEFAULT_STYLE, ...(it.style || {}) };
  let saved = false;

  const stats = it.type === 'polygon'
    ? `<div class="stat"><b>${esc(fmtArea(itemArea(it), sec()))}</b><br>Perímetro ${esc(fmtDist(itemLength(it)))} · ${it.coords.length} pontos</div>`
    : it.type === 'line'
      ? `<div class="stat"><b>${esc(fmtDist(itemLength(it)))}</b> · ${it.coords.length} pontos</div>`
      : `<div class="stat">${it.coords[0][0].toFixed(6)}, ${it.coords[0][1].toFixed(6)}</div>`;

  const icons = it.type === 'point'
    ? `<label class="f">Tipo de ponto</label><div class="icons">${Object.entries(POINT_ICONS).map(([k, v]) =>
      `<button type="button" class="icon-opt" data-icon="${k}">${pinSvg(v.color)}<span>${esc(v.label)}</span></button>`).join('')}</div>`
    : '';

  const body = openSheet(`${head(isNew ? 'Salvar medição' : (it.type === 'polygon' ? 'Área' : it.type === 'line' ? 'Linha' : 'Ponto'))}
    <div class="sheet-scroll">
      ${stats}
      <label class="f">Nome</label><input class="in" id="itName" maxlength="80" value="${esc(it.name)}">
      <label class="f">Pasta</label>
      <div class="row" style="margin-top:0"><select class="in" id="itFolder">${folderOptions(it.folderId)}</select>
        <button class="btn small" id="itNewFolder" type="button">+ Pasta</button></div>
      ${icons}
      ${it.type !== 'point' ? '<label class="f">Aparência</label>' + styleEditorHtml(it.type) : ''}
      <label class="f">Observação</label><textarea class="in" id="itDesc" maxlength="500">${esc(it.desc || '')}</textarea>
      ${isNew ? '' : `<div class="row wrap">
        <button class="btn" id="itShape" type="button">Ajustar pontos</button>
        <button class="btn" id="itZoom" type="button">Ver no mapa</button></div>
        <div class="row wrap"><button class="btn" id="itExport" type="button">Exportar só esta</button>
        <button class="btn danger" id="itDel" type="button">Excluir</button></div>`}
    </div>
    <div class="sheet-foot"><button class="btn" id="itCancel" type="button">${isNew ? 'Voltar ao desenho' : 'Cancelar'}</button>
      <button class="btn primary" id="itSave" type="button">Salvar</button></div>`,
    { full: true, onClose: () => { if (isNew && !saved && draw) redrawDraw(true); } });

  if (it.type !== 'point') bindStyleEditor(body, it.style, it.type);
  else {
    const mark = () => body.querySelectorAll('.icon-opt').forEach(b => b.classList.toggle('sel', b.dataset.icon === it.icon));
    body.querySelectorAll('.icon-opt').forEach(b => b.addEventListener('click', () => {
      const oldLabel = (POINT_ICONS[it.icon] || {}).label;
      it.icon = b.dataset.icon;
      const nm = $('itName');
      if (oldLabel && nm.value.startsWith(oldLabel + ' ')) nm.value = POINT_ICONS[it.icon].label + nm.value.slice(oldLabel.length);
      mark();
    }));
    mark();
  }

  const collect = () => {
    it.name = $('itName').value.trim() || orig.name;
    it.desc = $('itDesc').value.trim();
    it.folderId = $('itFolder').value || null;
  };

  $('itNewFolder').onclick = async () => {
    const name = await askText('Nova pasta', '', 'Criar');
    if (!name) return;
    const parent = $('itFolder').value || null;
    const f = addFolder(db, name, parent);
    db.activeFolder = f.id;
    persist();
    $('itFolder').innerHTML = folderOptions(f.id);
  };
  $('itCancel').onclick = () => closeSheet();
  $('itSave').onclick = () => {
    collect();
    saved = true;
    if (isNew) {
      db.items.push(it);
      if (it.folderId) db.activeFolder = it.folderId;
    } else {
      Object.assign(orig, it);
    }
    if (it.type === 'point') db.settings.lastIcon = it.icon;
    else db.settings.lastStyle = { ...it.style };
    persist();
    closeSheet(false);
    if (isNew) endDraw(); else renderItems();
    toast(isNew ? 'Medição salva' + (it.folderId ? ' em ' + folderPath(db, it.folderId) : '') : 'Alterações salvas');
  };
  if (!isNew) {
    $('itShape').onclick = () => startDraw(orig.type, orig);
    $('itZoom').onclick = () => { closeSheet(); fitTo(orig.coords); };
    $('itExport').onclick = () => exportDialog({ name: orig.name, tree: { name: orig.name, folders: [], items: [orig] } });
    $('itDel').onclick = async () => {
      if (!await askConfirm('Excluir', `Excluir "${orig.name}"?`, 'Excluir', true)) return;
      db.items = db.items.filter(i => i.id !== orig.id);
      persist();
      closeSheet(false);
      renderItems();
      toast('Excluído');
    };
  }
}

// ------------------------------------------------------------------ pastas

function openFolders() {
  const rows = [];
  const itemRow = (it, depth) => {
    const s = { ...DEFAULT_STYLE, ...(it.style || {}) };
    let dot;
    if (it.type === 'polygon') dot = `<span class="dot" style="border-color:${s.stroke};background:${s.fill}${Math.round(Math.max(0.15, s.fillOpacity) * 255).toString(16).padStart(2, '0')}"></span>`;
    else if (it.type === 'line') dot = `<span class="dot line" style="border-color:${s.stroke}"></span>`;
    else dot = `<span class="dot pt" style="border-color:#fff;background:${(POINT_ICONS[it.icon] || POINT_ICONS.red).color}"></span>`;
    const info = it.type === 'polygon' ? fmtArea(itemArea(it), sec()) : it.type === 'line' ? fmtDist(itemLength(it)) : (POINT_ICONS[it.icon] || POINT_ICONS.red).label;
    rows.push(`<div class="trow" style="padding-left:${10 + depth * 18}px">
      <button class="eye${it.visible === false ? ' off' : ''}" data-eye-item="${it.id}" type="button" aria-label="Mostrar/ocultar">${EYE}</button>${dot}
      <button class="nm" data-item="${it.id}" type="button"><div>${esc(it.name)}</div><small>${esc(info)}</small></button></div>`);
  };
  const walk = (parentId, depth) => {
    for (const f of childFolders(db, parentId)) {
      const t = folderTotals(db, f.id);
      rows.push(`<div class="trow folder${f.id === db.activeFolder ? ' active' : ''}" style="padding-left:${depth * 18}px">
        <button class="tw" data-toggle="${f.id}" type="button" aria-label="Abrir/fechar">${f.open === false ? '▸' : '▾'}</button>
        <button class="eye${f.visible === false ? ' off' : ''}" data-eye-folder="${f.id}" type="button" aria-label="Mostrar/ocultar">${EYE}</button>
        <button class="nm" data-folder="${f.id}" type="button"><div>📁 ${esc(f.name)}${f.id === db.activeFolder ? '<span class="badge">ATIVA</span>' : ''}</div>
          <small>${t.count} ${t.count === 1 ? 'medição' : 'medições'}${t.area ? ' · ' + esc(fmtArea(t.area, sec())) : ''}</small></button>
        <button class="more" data-menu="${f.id}" type="button" aria-label="Opções da pasta">⋮</button></div>`);
      if (f.open !== false) {
        walk(f.id, depth + 1);
        for (const it of folderItems(db, f.id)) itemRow(it, depth + 1);
      }
    }
  };
  walk(null, 0);
  const loose = folderItems(db, null);
  if (loose.length) {
    rows.push(`<div class="trow folder"><span class="tw"></span><div class="nm"><div>Sem pasta</div><small>${loose.length} ${loose.length === 1 ? 'medição' : 'medições'}</small></div></div>`);
    for (const it of loose) itemRow(it, 1);
  }
  const total = folderTotals(db, null);
  const scrollTop = $('sheetBody').querySelector('.sheet-scroll')?.scrollTop || 0;

  const body = openSheet(`${head('Pastas e medições')}
    <div class="sheet-scroll">
      <div class="row wrap" style="margin-top:0">
        <button class="btn small" id="fNew" type="button">+ Nova pasta</button>
        <button class="btn small" id="fImport" type="button">Importar KML/KMZ</button>
        <button class="btn small" id="fAll" type="button"${db.items.length ? '' : ' disabled'}>Exportar tudo</button>
      </div>
      <p class="hint" style="margin:8px 0 10px">Toque no nome de uma pasta para deixá-la ativa: as próximas medições vão para ela. Total: ${total.count} medições · ${esc(fmtArea(total.area, sec()))}</p>
      <div class="tree">${rows.join('') || '<div class="empty">Nenhuma pasta ainda.<br>Crie uma pasta (por exemplo, o nome da fazenda) e todas as medições que você fizer vão para dentro dela.</div>'}</div>
    </div>`, { full: true });
  body.querySelector('.sheet-scroll').scrollTop = scrollTop;

  $('fNew').onclick = async () => {
    const name = await askText('Nova pasta', '', 'Criar');
    if (!name) return;
    const f = addFolder(db, name, null);
    db.activeFolder = f.id;
    persist(); updateChip(); openFolders();
  };
  $('fImport').onclick = () => $('fileInput').click();
  $('fAll').onclick = () => exportDialog({ name: 'PV Area - tudo', tree: exportTree(db, null, 'PV Área') });
  body.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => {
    const f = db.folders.find(x => x.id === b.dataset.toggle);
    f.open = f.open === false; persist(); openFolders();
  });
  body.querySelectorAll('[data-eye-folder]').forEach(b => b.onclick = () => {
    const f = db.folders.find(x => x.id === b.dataset.eyeFolder);
    f.visible = f.visible === false; persist(); renderItems(); openFolders();
  });
  body.querySelectorAll('[data-eye-item]').forEach(b => b.onclick = () => {
    const it = db.items.find(x => x.id === b.dataset.eyeItem);
    it.visible = it.visible === false; persist(); renderItems(); openFolders();
  });
  body.querySelectorAll('[data-folder]').forEach(b => b.onclick = () => {
    db.activeFolder = db.activeFolder === b.dataset.folder ? null : b.dataset.folder;
    persist(); updateChip(); openFolders();
  });
  body.querySelectorAll('[data-menu]').forEach(b => b.onclick = () => folderMenu(b.dataset.menu));
  body.querySelectorAll('[data-item]').forEach(b => b.onclick = () => {
    const it = db.items.find(x => x.id === b.dataset.item);
    fitTo(it.coords);
    openItemSheet(it.id);
  });
}

function folderMenu(id) {
  const f = db.folders.find(x => x.id === id);
  if (!f) return;
  const t = folderTotals(db, id);
  const body = openSheet(`${head('📁 ' + f.name)}
    <div class="sheet-scroll menu">
      <div class="stat">${t.count} ${t.count === 1 ? 'medição' : 'medições'} · <b>${esc(fmtArea(t.area, sec()))}</b></div>
      <button class="btn primary" id="mExport" type="button"${t.count ? '' : ' disabled'}>Exportar pasta inteira (KML / KMZ)</button>
      <button class="btn" id="mActive" type="button">${db.activeFolder === id ? 'Deixar de ser a pasta ativa' : 'Definir como pasta ativa'}</button>
      <button class="btn" id="mSub" type="button">Nova subpasta</button>
      <button class="btn" id="mZoom" type="button"${t.count ? '' : ' disabled'}>Ver no mapa</button>
      <button class="btn" id="mStyle" type="button"${t.count ? '' : ' disabled'}>Cor e transparência de todas as áreas</button>
      <button class="btn" id="mRename" type="button">Renomear</button>
      <button class="btn" id="mMove" type="button">Mover para outra pasta</button>
      <button class="btn danger" id="mDel" type="button">Excluir pasta</button>
    </div>`, { onClose: openFolders });
  const back = () => { closeSheet(false); openFolders(); };
  $('mExport').onclick = () => exportDialog({ name: f.name, tree: exportTree(db, id) });
  $('mActive').onclick = () => { db.activeFolder = db.activeFolder === id ? null : id; persist(); updateChip(); back(); };
  $('mSub').onclick = async () => {
    const name = await askText('Nova subpasta em ' + f.name, '', 'Criar');
    if (!name) return;
    const sub = addFolder(db, name, id);
    f.open = true; db.activeFolder = sub.id;
    persist(); updateChip(); back();
  };
  $('mZoom').onclick = () => { closeSheet(false); fitTo(allCoords(itemsDeep(db, id))); };
  $('mStyle').onclick = () => folderStyle(id);
  $('mRename').onclick = async () => {
    const name = await askText('Renomear pasta', f.name);
    if (!name) return;
    f.name = name; persist(); updateChip(); back();
  };
  $('mMove').onclick = () => {
    const b2 = openSheet(`${head('Mover "' + f.name + '"')}
      <div class="sheet-scroll"><label class="f">Colocar dentro de</label>
      <select class="in" id="mvSel">${folderOptions(f.parentId, id).replace('(sem pasta)', '(nível principal)')}</select></div>
      <div class="sheet-foot"><button class="btn" data-close type="button">Cancelar</button><button class="btn primary" id="mvOk" type="button">Mover</button></div>`, { onClose: openFolders });
    b2.querySelector('#mvOk').onclick = () => {
      const dest = $('mvSel').value || null;
      if (canMoveFolder(db, id, dest)) { f.parentId = dest; persist(); }
      back();
    };
  };
  $('mDel').onclick = async () => {
    const msg = t.count ? `Excluir a pasta "${f.name}" com ${t.count} ${t.count === 1 ? 'medição' : 'medições'} dentro?\nIsso não pode ser desfeito.` : `Excluir a pasta "${f.name}"?`;
    if (!await askConfirm('Excluir pasta', msg, 'Excluir', true)) return;
    removeFolder(db, id);
    persist(); renderItems(); back();
  };
}

function folderStyle(id) {
  const f = db.folders.find(x => x.id === id);
  const items = itemsDeep(db, id).filter(i => i.type !== 'point');
  const first = items.find(i => i.type === 'polygon') || items[0];
  const style = { ...DEFAULT_STYLE, ...((first && first.style) || db.settings.lastStyle) };
  const body = openSheet(`${head('Aparência — ' + f.name)}
    <div class="sheet-scroll">${styleEditorHtml('polygon')}
      <p class="hint">Vale para todas as áreas e linhas desta pasta e das subpastas (${items.length}). As linhas usam só o contorno.</p></div>
    <div class="sheet-foot"><button class="btn" data-close type="button">Cancelar</button>
      <button class="btn primary" id="fsOk" type="button">Aplicar a todas</button></div>`, { full: true, onClose: openFolders });
  bindStyleEditor(body, style, 'polygon');
  $('fsOk').onclick = () => {
    for (const it of items) it.style = { ...style };
    db.settings.lastStyle = { ...style };
    persist(); renderItems();
    closeSheet(false); openFolders();
    toast(`Aparência aplicada a ${items.length} ${items.length === 1 ? 'medição' : 'medições'}`);
  };
}

// ------------------------------------------------------------------ exportar e importar

async function buildFile(name, tree, fmt) {
  const kml = buildKml(tree, { descArea: db.settings.descArea, secondary: sec() });
  const base = safeFileName(name);
  if (fmt === 'kml') return { name: base + '.kml', mime: 'application/vnd.google-earth.kml+xml', text: kml };
  const zip = new JSZip();
  zip.file('doc.kml', kml);
  const base64 = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
  return { name: base + '.kmz', mime: 'application/vnd.google-earth.kmz', base64 };
}

function exportDialog({ name, tree }) {
  if (!tree) return;
  const n = countTree(tree);
  if (!n) { toast('Não há medições para exportar'); return; }
  let fmt = db.settings.lastFmt || 'kml';
  const body = openSheet(`${head('Exportar')}
    <div class="sheet-scroll">
      <div class="stat"><b>${esc(name)}</b><br>${n} ${n === 1 ? 'medição' : 'medições'} em um único arquivo, com as pastas</div>
      <label class="f">Formato</label>
      <div class="seg"><button type="button" data-fmt="kml">KML</button><button type="button" data-fmt="kmz">KMZ (compactado)</button></div>
      <div class="row"><button class="btn primary" id="exShare" type="button">Enviar / compartilhar</button></div>
      <div class="row"><button class="btn" id="exSave" type="button">Salvar no celular</button></div>
      <p class="hint">"Salvar no celular" grava em Documentos/PVArea.</p>
    </div>`);
  const mark = () => body.querySelectorAll('[data-fmt]').forEach(b => b.classList.toggle('sel', b.dataset.fmt === fmt));
  body.querySelectorAll('[data-fmt]').forEach(b => b.onclick = () => { fmt = b.dataset.fmt; db.settings.lastFmt = fmt; persist(); mark(); });
  mark();
  $('exShare').onclick = async () => {
    try { await shareFile(await buildFile(name, tree, fmt)); closeSheet(false); }
    catch (e) { toast('Falha ao exportar: ' + (e.message || e), 5000); }
  };
  $('exSave').onclick = async () => {
    try {
      const file = await buildFile(name, tree, fmt);
      const where = await saveToDocuments(file);
      closeSheet(false);
      toast('Salvo em ' + where, 5000);
    } catch (e) {
      toast('Não consegui salvar em Documentos. Use "Enviar / compartilhar".', 5000);
    }
  };
}

async function importFiles(files) {
  let total = 0, lastFolder = null;
  for (const file of files) {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let xml;
      if (buf[0] === 0x50 && buf[1] === 0x4b) {
        const zip = await JSZip.loadAsync(buf);
        const names = Object.keys(zip.files).filter(n => /\.kml$/i.test(n) && !zip.files[n].dir);
        const pick = names.find(n => /(^|\/)doc\.kml$/i.test(n)) || names[0];
        if (!pick) throw new Error('KMZ sem arquivo KML dentro');
        xml = await zip.file(pick).async('string');
      } else {
        xml = new TextDecoder('utf-8').decode(buf);
      }
      const tree = parseKml(xml, DOMParser, file.name.replace(/\.(kml|kmz)$/i, ''));
      lastFolder = importTree(db, tree, null);
      total += countTree(tree);
    } catch (e) {
      toast(`${file.name}: ${e.message || 'não foi possível ler'}`, 5000);
    }
  }
  if (!total) return;
  persist();
  renderItems();
  closeSheet(false);
  fitTo(allCoords(itemsDeep(db, lastFolder.id)));
  toast(`${total} ${total === 1 ? 'medição importada' : 'medições importadas'}`);
}

// ------------------------------------------------------------------ camadas e configurações

function openLayers() {
  const body = openSheet(`${head('Tipo de mapa')}
    <div class="sheet-scroll menu">${Object.entries(BASES).map(([k, v]) =>
    `<button class="btn${db.settings.base === k ? ' primary' : ''}" data-base="${k}" type="button">${esc(v.label)}</button>`).join('')}
    <p class="hint">As imagens da Esri ficam guardadas no celular depois de vistas, para aparecerem sem sinal.</p></div>`);
  body.querySelectorAll('[data-base]').forEach(b => b.onclick = async () => {
    if (b.dataset.base.startsWith('google') && !db.settings.googleKey) {
      closeSheet(false); openSettings(); toast('Cole a chave do Google Maps para usar esta imagem', 4000); return;
    }
    db.settings.base = b.dataset.base;
    persist(); closeSheet(false);
    await setBase();
  });
}

async function openSettings() {
  const s = db.settings;
  const opt = (v, cur, label) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${esc(label)}</option>`;
  const body = openSheet(`${head('Configurações')}
    <div class="sheet-scroll">
      <label class="f">Segunda unidade de área (além de hectare)</label>
      <select class="in" id="sSec">${Object.entries(SECONDARY_UNITS).map(([k, v]) => opt(k, s.secondary, v.label)).join('')}</select>
      <label class="f">Nomes no mapa</label>
      <select class="in" id="sLab">${opt('name_area', s.labels, 'Nome e área')}${opt('name', s.labels, 'Só o nome')}${opt('none', s.labels, 'Não mostrar')}</select>
      <label class="check"><input type="checkbox" id="sSeg"${s.segLabels ? ' checked' : ''}> Mostrar o comprimento de cada lado ao desenhar</label>
      <label class="check"><input type="checkbox" id="sDesc"${s.descArea ? ' checked' : ''}> Gravar área e perímetro na descrição do KML</label>

      <label class="f">GPS: distância mínima entre pontos ao caminhar</label>
      <select class="in" id="sMin">${[1, 2, 3, 5, 10, 20].map(v => opt(v, s.gpsMinDist, v + ' m')).join('')}</select>
      <label class="f">GPS: ignorar posições com precisão pior que</label>
      <select class="in" id="sAcc">${[5, 10, 15, 25, 50].map(v => opt(v, s.gpsMaxAcc, '±' + v + ' m')).join('')}</select>

      <label class="f">Zoom máximo da imagem Esri</label>
      <select class="in" id="sZoom">${[16, 17, 18, 19].map(v => opt(v, s.maxNativeZoom || 18, 'Nível ' + v)).join('')}</select>
      <p class="hint">Se ao aproximar aparecer "Map data not yet available", diminua um nível: a imagem é ampliada em vez de sumir.</p>

      <label class="f">Chave do Google Maps (opcional)</label>
      <input class="in" id="sKey" value="${esc(s.googleKey)}" placeholder="AIza…" autocomplete="off" autocapitalize="off" spellcheck="false">
      <p class="hint">Só é necessária para a imagem do Google. A chave precisa ter a "Map Tiles API" ativada no Google Cloud.</p>

      <label class="f">Imagens guardadas no celular</label>
      <div class="row" style="margin-top:0"><div class="stat" style="flex:1" id="sCache">contando…</div>
        <button class="btn small" id="sClear" type="button">Limpar</button></div>
      <p class="hint" style="margin-top:14px">PV Área ${esc(import.meta.env?.VITE_APP_VERSION || '')} · Pasto Verde Consultoria</p>
    </div>
    <div class="sheet-foot"><button class="btn primary" data-close type="button">Concluir</button></div>`,
    { full: true, onClose: () => { persist(); renderItems(); if (draw) redrawDraw(true); } });

  const count = async () => { $('sCache') && ($('sCache').textContent = (await cachedTileCount()).toLocaleString('pt-BR') + ' quadros de imagem'); };
  count();
  $('sSec').onchange = e => { s.secondary = e.target.value; };
  $('sLab').onchange = e => { s.labels = e.target.value; };
  $('sSeg').onchange = e => { s.segLabels = e.target.checked; };
  $('sDesc').onchange = e => { s.descArea = e.target.checked; };
  $('sMin').onchange = e => { s.gpsMinDist = Number(e.target.value); };
  $('sAcc').onchange = e => { s.gpsMaxAcc = Number(e.target.value); };
  $('sZoom').onchange = e => { s.maxNativeZoom = Number(e.target.value); setBase(); };
  $('sKey').onchange = e => { s.googleKey = e.target.value.trim(); if (s.base.startsWith('google')) setBase(); };
  $('sClear').onclick = async () => {
    if (!await askConfirm('Limpar imagens', 'Apagar as imagens de satélite guardadas? Suas medições não são afetadas.', 'Limpar', true)) return;
    await clearTileCache(); count();
  };
  return body;
}

// ------------------------------------------------------------------ barra inferior

const ICON = {
  area: '<svg viewBox="0 0 24 24"><path d="M5 3a2 2 0 0 1 1.900 1.400L17 5.800a2 2 0 1 1 2.300 2.800l.6 8.500a2 2 0 1 1-2.300 2.700L6.800 19a2 2 0 1 1-2.700-2.300L4 6.800A2 2 0 0 1 5 3Zm1.600 3.400a2 2 0 0 1-.6.300l.100 9.900c.3.100.6.300.8.600l10.800.800c.100-.3.3-.600.6-.800l-.6-8.600a2 2 0 0 1-.9-.700L6.600 6.400Z"/></svg>',
  line: '<svg viewBox="0 0 24 24"><path d="M5 15a3 3 0 1 1 2.800 4L5 19a3 3 0 0 1 0-4Zm14-10a3 3 0 1 1-2.100 5.100L8.900 16l-1.200-1.600 8-5.900A3 3 0 0 1 19 5Z"/></svg>',
  point: '<svg viewBox="0 0 24 24"><path d="M12 22S5 13.500 5 9a7 7 0 0 1 14 0c0 4.500-7 13-7 13Zm0-10.500a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5Z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h4.500l2 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 5 3 11l6 6v-4h5a4 4 0 0 1 0 8h-2v2h2a6 6 0 0 0 0-12H9V5Z"/></svg>',
  gps: '<svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9 3h-2.100A7 7 0 0 0 13 5.100V3h-2v2.100A7 7 0 0 0 5.100 11H3v2h2.100A7 7 0 0 0 11 18.900V21h2v-2.100A7 7 0 0 0 18.900 13H21v-2Z"/></svg>',
  rec: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="m6.400 5 5.600 5.600L17.600 5 19 6.400 13.400 12l5.600 5.600-1.400 1.400-5.600-5.600L6.400 19 5 17.600 10.600 12 5 6.400 6.400 5Z"/></svg>',
  ok: '<svg viewBox="0 0 24 24"><path d="m9.500 16.200-4.200-4.200L3.900 13.400l5.600 5.600 11-11-1.400-1.400L9.500 16.200Z"/></svg>'
};

function renderBottom() {
  const bar = $('bottombar');
  if (!draw) {
    bar.innerHTML = `
      <button class="bb primary" id="bbArea" type="button">${ICON.area}<span>Área</span></button>
      <button class="bb" id="bbLine" type="button">${ICON.line}<span>Distância</span></button>
      <button class="bb" id="bbPoint" type="button">${ICON.point}<span>Ponto</span></button>
      <button class="bb" id="bbFolders" type="button">${ICON.folder}<span>Pastas</span></button>`;
    $('bbArea').onclick = () => startMeasure('polygon');
    $('bbLine').onclick = () => startMeasure('line');
    $('bbPoint').onclick = () => startMeasure('point');
    $('bbFolders').onclick = openFolders;
    return;
  }
  const multi = draw.type !== 'point';
  let mid = '';
  if (draw.mode === 'gps-mark') {
    mid = `<button class="bb wide mark" id="bbMark" type="button">${ICON.gps}<span>${multi ? 'Marcar ponto' : 'Usar posição'}</span></button>`;
  } else if (draw.mode === 'gps-walk') {
    mid = `<button class="bb wide${draw.recording ? ' rec' : ''}" id="bbRec" type="button">${draw.recording ? ICON.pause : ICON.rec}<span>${draw.recording ? 'Pausar' : 'Retomar'}</span></button>`;
  }
  bar.innerHTML = `
    <button class="bb warn" id="bbCancel" type="button">${ICON.x}<span>Cancelar</span></button>
    ${multi ? `<button class="bb" id="bbUndo" type="button">${ICON.undo}<span>Desfazer</span></button>` : ''}
    ${mid}
    <button class="bb primary" id="bbDone" type="button">${ICON.ok}<span>Concluir</span></button>`;
  $('bbCancel').onclick = cancelDraw;
  if (multi) { $('bbUndo').onclick = undoPoint; $('bbUndo').disabled = !draw.coords.length; }
  if ($('bbMark')) $('bbMark').onclick = gpsPoint;
  if ($('bbRec')) $('bbRec').onclick = toggleRecord;
  $('bbDone').onclick = finishDraw;
  $('bbDone').disabled = !canFinish();
}

// ------------------------------------------------------------------ início

function handleBack() {
  if ($('modal').classList.contains('open')) { closeModal(null); return true; }
  if ($('sheet').classList.contains('open')) { closeSheet(); return true; }
  if (draw) { cancelDraw(); return true; }
  return false;
}

async function init() {
  db = normalizeDb(await loadDb());

  map = L.map('map', { zoomControl: false, attributionControl: true, maxZoom: 22, zoomSnap: 0.5, tap: false });
  map.attributionControl.setPrefix(false);
  baseGroup = L.layerGroup().addTo(map);
  itemGroup = L.layerGroup().addTo(map);
  drawGroup = L.layerGroup().addTo(map);
  gpsLayer = L.layerGroup().addTo(map);
  L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);

  const start = allCoords(db.items.filter(i => isVisible(db, i)));
  if (start.length) fitTo(start); else map.setView([-12.6, -41.7], 6);

  let lastHint = 0;
  map.on('click', e => {
    if (!draw || draw.recording) return;
    if (draw.mode !== 'manual') {
      if (Date.now() - lastHint > 4000) { lastHint = Date.now(); toast('Neste modo os pontos vêm do GPS. Toque em "Modo" no topo para marcar à mão.', 3500); }
      return;
    }
    addPoint([e.latlng.lat, e.latlng.lng]);
  });
  const zoomClass = () => map.getContainer().classList.toggle('zoom-far', map.getZoom() < 13);
  map.on('zoomend', zoomClass); zoomClass();

  await setBase();
  renderItems();
  renderBottom();
  updateHud();

  $('btnFolder').onclick = openFolders;
  $('hud').addEventListener('click', e => { if (e.target.closest('[data-mode]')) changeMode(); });
  $('btnLayers').onclick = openLayers;
  $('btnSettings').onclick = openSettings;
  $('btnFit').onclick = () => {
    const c = allCoords(db.items.filter(i => isVisible(db, i)));
    if (c.length) fitTo(c); else toast('Nenhuma medição para mostrar');
  };
  $('btnLocate').onclick = async () => {
    if (gps.stop && !draw) { stopGps(); return; }
    followOnce = true;
    if (gps.fix) { map.setView([gps.fix.lat, gps.fix.lng], Math.max(map.getZoom(), 17)); followOnce = false; }
    await startGps();
    $('btnLocate').classList.add('on');
  };
  $('fileInput').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) await importFiles(files);
  });
  $('sheet').addEventListener('click', e => { if (e.target === $('sheet')) closeSheet(); });
  onBackButton(handleBack);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveDb(db); });

  // medição que ficou pela metade (app fechado no meio da caminhada)
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (d && Array.isArray(d.coords) && d.coords.length >= 2 && (d.type === 'polygon' || d.type === 'line')) {
      const ok = await askConfirm('Medição não concluída', `Há uma medição com ${d.coords.length} pontos que não foi salva. Continuar?`, 'Continuar');
      if (ok) startDraw(d.type, { coords: d.coords, id: null });
      else clearDraft();
    }
  } catch { clearDraft(); }

  if (!db.items.length && !draw) { followOnce = true; startGps().then(() => $('btnLocate').classList.add('on')); }
}

window.__pv = { get db() { return db; }, get draw() { return draw; }, get map() { return map; } };
init();
