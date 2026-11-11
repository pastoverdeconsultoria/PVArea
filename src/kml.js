// Geração e leitura de KML. Estrutura igual à do Google Earth do computador:
// Document > Folder > (Folder...) > Placemark, com estilos compartilhados.

import { DEFAULT_STYLE, POINT_ICONS, itemArea, itemLength } from './model.js';
import { fmtArea, fmtDist } from './geo.js';

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** '#rrggbb' + opacidade 0..1 -> 'aabbggrr' (ordem do KML). */
export function toKmlColor(hex, opacity = 1) {
  let h = String(hex || '#ffffff').replace('#', '').toLowerCase();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/.test(h)) h = 'ffffff';
  const a = Math.round(Math.min(1, Math.max(0, Number(opacity))) * 255).toString(16).padStart(2, '0');
  return a + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2);
}

/** 'aabbggrr' -> { hex:'#rrggbb', opacity } */
export function fromKmlColor(k) {
  let s = String(k || '').trim().replace('#', '').toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(s)) {
    if (/^[0-9a-f]{6}$/.test(s)) s = 'ff' + s; else return null;
  }
  return {
    hex: '#' + s.slice(6, 8) + s.slice(4, 6) + s.slice(2, 4),
    opacity: Math.round((parseInt(s.slice(0, 2), 16) / 255) * 100) / 100
  };
}

function coordStr(coords, close) {
  const pts = coords.map(c => `${+c[1].toFixed(7)},${+c[0].toFixed(7)},0`);
  if (close && coords.length) pts.push(pts[0]);
  return pts.join(' ');
}

function styleXml(id, it) {
  if (it.type === 'point') {
    const ic = POINT_ICONS[it.icon] || POINT_ICONS.red;
    return `<Style id="${id}"><IconStyle><scale>1.1</scale><Icon><href>${esc(ic.href)}</href></Icon>` +
      `<hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/></IconStyle>` +
      `<LabelStyle><scale>0.9</scale></LabelStyle></Style>`;
  }
  const s = { ...DEFAULT_STYLE, ...(it.style || {}) };
  const line = `<LineStyle><color>${toKmlColor(s.stroke, s.strokeOpacity)}</color><width>${+s.width}</width></LineStyle>`;
  if (it.type === 'line') return `<Style id="${id}">${line}</Style>`;
  return `<Style id="${id}">${line}<PolyStyle><color>${toKmlColor(s.fill, s.fillOpacity)}</color>` +
    `<fill>${s.fillOpacity > 0 ? 1 : 0}</fill><outline>1</outline></PolyStyle></Style>`;
}

function styleKey(it) {
  if (it.type === 'point') return 'p|' + (POINT_ICONS[it.icon] ? it.icon : 'red');
  const s = { ...DEFAULT_STYLE, ...(it.style || {}) };
  const base = `${s.stroke}|${s.strokeOpacity}|${s.width}`;
  return it.type === 'line' ? 'l|' + base : `a|${base}|${s.fill}|${s.fillOpacity}`;
}

/**
 * tree = { name, folders:[tree...], items:[item...] }
 * opts = { descArea:boolean, secondary:string }
 */
export function buildKml(tree, opts = {}) {
  const styles = new Map();
  const styleId = it => {
    const k = styleKey(it);
    if (!styles.has(k)) styles.set(k, { id: 'pv' + (styles.size + 1), xml: null, it });
    return styles.get(k).id;
  };

  const placemark = (it, ind) => {
    const sid = styleId(it);
    let desc = it.desc ? String(it.desc) : '';
    if (opts.descArea !== false) {
      let m = '';
      if (it.type === 'polygon') {
        m = `Área: ${fmtArea(itemArea(it), opts.secondary)} | Perímetro: ${fmtDist(itemLength(it))}`;
      } else if (it.type === 'line') {
        m = `Distância: ${fmtDist(itemLength(it))}`;
      }
      if (m) desc = desc ? `${m}\n${desc}` : m;
    }
    let geom;
    if (it.type === 'point') {
      geom = `<Point><coordinates>${coordStr([it.coords[0]], false)}</coordinates></Point>`;
    } else if (it.type === 'line') {
      geom = `<LineString><tessellate>1</tessellate><coordinates>${coordStr(it.coords, false)}</coordinates></LineString>`;
    } else {
      const inner = (it.holes || []).map(h =>
        `<innerBoundaryIs><LinearRing><coordinates>${coordStr(h, true)}</coordinates></LinearRing></innerBoundaryIs>`).join('');
      geom = `<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>` +
        `${coordStr(it.coords, true)}</coordinates></LinearRing></outerBoundaryIs>${inner}</Polygon>`;
    }
    return `${ind}<Placemark><name>${esc(it.name)}</name>` +
      (desc ? `<description>${esc(desc)}</description>` : '') +
      `<styleUrl>#${sid}</styleUrl>${geom}</Placemark>\n`;
  };

  const folder = (f, ind) => {
    let s = `${ind}<Folder><name>${esc(f.name)}</name><open>1</open>\n`;
    for (const sub of f.folders || []) s += folder(sub, ind + '  ');
    for (const it of f.items || []) if (validItem(it)) s += placemark(it, ind + '  ');
    return s + `${ind}</Folder>\n`;
  };

  let body = '';
  for (const f of tree.folders || []) body += folder(f, '  ');
  for (const it of tree.items || []) if (validItem(it)) body += placemark(it, '  ');

  let st = '';
  for (const v of styles.values()) st += '  ' + styleXml(v.id, v.it) + '\n';

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n  <name>${esc(tree.name)}</name>\n  <open>1</open>\n` +
    st + body + `</Document>\n</kml>\n`;
}

export function validItem(it) {
  if (!it || !Array.isArray(it.coords)) return false;
  if (it.type === 'point') return it.coords.length >= 1;
  if (it.type === 'line') return it.coords.length >= 2;
  if (it.type === 'polygon') return it.coords.length >= 3;
  return false;
}

// ------------------------------------------------------------------ leitura

const ln = el => el.localName || String(el.nodeName).replace(/^.*:/, '');

function kids(el, name) {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!name || ln(n) === name)) out.push(n);
  }
  return out;
}
const kid = (el, name) => kids(el, name)[0] || null;
const text = (el, name) => {
  const k = el && kid(el, name);
  return k ? (k.textContent || '').trim() : '';
};

function parseCoords(str) {
  const out = [];
  for (const tok of String(str || '').trim().split(/\s+/)) {
    if (!tok) continue;
    const p = tok.split(',');
    const lng = parseFloat(p[0]), lat = parseFloat(p[1]);
    if (isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) out.push([lat, lng]);
  }
  return out;
}

function openRing(c) {
  if (c.length > 1) {
    const a = c[0], b = c[c.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) return c.slice(0, -1);
  }
  return c;
}

function iconFromHref(href) {
  const h = String(href || '').toLowerCase();
  if (!h) return 'red';
  if (/ltblue|lightblue/.test(h)) return 'ltblue';
  if (/water|blue|blu-/.test(h)) return 'blue';
  if (/ylw|yellow/.test(h)) return 'yellow';
  if (/grn|green/.test(h)) return 'green';
  if (/orange/.test(h)) return 'orange';
  if (/purple/.test(h)) return 'purple';
  if (/pink/.test(h)) return 'pink';
  return 'red';
}

function readStyle(el) {
  const s = {};
  const line = kid(el, 'LineStyle');
  if (line) {
    const c = fromKmlColor(text(line, 'color'));
    if (c) { s.stroke = c.hex; s.strokeOpacity = c.opacity; }
    const w = parseFloat(text(line, 'width'));
    if (isFinite(w) && w > 0) s.width = Math.min(12, Math.max(1, w));
  }
  const poly = kid(el, 'PolyStyle');
  if (poly) {
    const c = fromKmlColor(text(poly, 'color'));
    if (c) { s.fill = c.hex; s.fillOpacity = c.opacity; }
    if (text(poly, 'fill') === '0') s.fillOpacity = 0;
  }
  const icon = kid(el, 'IconStyle');
  if (icon) {
    const ic = kid(icon, 'Icon');
    s.icon = iconFromHref(ic ? text(ic, 'href') : '');
  }
  return s;
}

function collectStyles(root) {
  const styles = {}, maps = {};
  const walk = el => {
    for (const c of kids(el)) {
      const name = ln(c);
      const id = c.getAttribute && (c.getAttribute('id') || c.getAttribute('kml:id'));
      if (name === 'Style' && id) styles[id] = readStyle(c);
      else if (name === 'CascadingStyle' && id) {
        const st = kid(c, 'Style');
        if (st) styles[id] = readStyle(st);
      } else if (name === 'StyleMap' && id) {
        let chosen = null;
        for (const pair of kids(c, 'Pair')) {
          const key = text(pair, 'key');
          const inline = kid(pair, 'Style');
          const ref = text(pair, 'styleUrl').replace(/^.*#/, '');
          if (key === 'normal' || !chosen) chosen = inline ? { inline: readStyle(inline) } : { ref };
        }
        if (chosen) maps[id] = chosen;
      }
      if (name === 'Document' || name === 'Folder' || name === 'kml') walk(c);
    }
  };
  walk(root);
  for (const id in maps) {
    const m = maps[id];
    styles[id] = m.inline || styles[m.ref] || {};
  }
  return styles;
}

function geometries(el, out = []) {
  for (const g of kids(el)) {
    const name = ln(g);
    if (name === 'Polygon') {
      const ob = kid(g, 'outerBoundaryIs');
      const lr = ob && kid(ob, 'LinearRing');
      const outer = openRing(parseCoords(lr ? text(lr, 'coordinates') : ''));
      const holes = kids(g, 'innerBoundaryIs').map(ib => {
        const r = kid(ib, 'LinearRing');
        return openRing(parseCoords(r ? text(r, 'coordinates') : ''));
      }).filter(h => h.length >= 3);
      if (outer.length >= 3) out.push({ type: 'polygon', coords: outer, holes });
    } else if (name === 'LineString' || name === 'LinearRing') {
      const c = parseCoords(text(g, 'coordinates'));
      if (c.length >= 2) out.push({ type: 'line', coords: c });
    } else if (name === 'Point') {
      const c = parseCoords(text(g, 'coordinates'));
      if (c.length) out.push({ type: 'point', coords: [c[0]] });
    } else if (name === 'MultiGeometry') {
      geometries(g, out);
    }
  }
  return out;
}

/**
 * Lê um KML e devolve { name, folders, items } pronto para importTree().
 * DOMParserImpl: classe DOMParser (a do navegador ou a do @xmldom/xmldom nos testes).
 */
export function parseKml(xml, DOMParserImpl, fallbackName = 'Importado') {
  const doc = new DOMParserImpl().parseFromString(String(xml).replace(/^﻿/, ''), 'text/xml');
  const root = doc.documentElement;
  if (!root || ln(root) === 'parsererror' || doc.getElementsByTagName('parsererror').length) {
    throw new Error('Arquivo KML inválido');
  }
  const styles = collectStyles(root);

  const readContainer = (el, name, wrapper) => {
    const node = { name: name || fallbackName, folders: [], items: [], wrapper };
    for (const c of kids(el)) {
      const n = ln(c);
      if (n === 'Folder' || n === 'Document') {
        const sub = readContainer(c, text(c, 'name') || (n === 'Folder' ? 'Pasta' : fallbackName), n === 'Document');
        if (sub.folders.length || sub.items.length) node.folders.push(sub);
      } else if (n === 'Placemark') {
        const url = text(c, 'styleUrl').replace(/^.*#/, '');
        const inline = kid(c, 'Style');
        const st = { ...(styles[url] || {}), ...(inline ? readStyle(inline) : {}) };
        const geoms = geometries(c);
        const pmName = text(c, 'name');
        const rawDesc = text(c, 'description').replace(/<[^>]+>/g, ' ').replace(/\s+\n/g, '\n').trim();
        const desc = rawDesc.replace(/^(Área|Distância): [^\n]*\n?/, '').trim();
        geoms.forEach((g, i) => {
          const it = {
            type: g.type,
            name: (pmName || (g.type === 'point' ? 'Ponto' : g.type === 'line' ? 'Linha' : 'Área')) +
              (geoms.length > 1 ? ` (${i + 1})` : ''),
            desc,
            coords: g.coords
          };
          if (g.type === 'polygon') {
            if (g.holes && g.holes.length) it.holes = g.holes;
            it.style = {
              ...DEFAULT_STYLE,
              stroke: st.stroke || '#ffffff', strokeOpacity: st.strokeOpacity ?? 1, width: st.width || 2,
              fill: st.fill || st.stroke || '#ffffff', fillOpacity: st.fillOpacity ?? 0.3
            };
          } else if (g.type === 'line') {
            it.style = {
              ...DEFAULT_STYLE,
              stroke: st.stroke || '#ffffff', strokeOpacity: st.strokeOpacity ?? 1, width: st.width || 3
            };
          } else {
            it.icon = st.icon || 'red';
          }
          node.items.push(it);
        });
      }
    }
    return node;
  };

  let top = readContainer(root, fallbackName, true);
  // <kml> e <Document> que só embrulham uma única pasta não viram pasta própria;
  // pastas de verdade (Folder) são sempre mantidas
  let guard = 0;
  while (top.wrapper && top.items.length === 0 && top.folders.length === 1 && guard++ < 10) top = top.folders[0];
  const strip = n => { delete n.wrapper; n.folders.forEach(strip); };
  strip(top);
  if (!top.items.length && !top.folders.length) throw new Error('Nenhuma medição encontrada no arquivo');
  return top;
}

export function countTree(t) {
  let n = (t.items || []).length;
  for (const f of t.folders || []) n += countTree(f);
  return n;
}
