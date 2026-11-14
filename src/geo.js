// Cálculos geodésicos no elipsoide WGS84. Coordenadas sempre como [lat, lng] em graus.

const A = 6378137.0;
const F = 1 / 298.257223563;
const B = A * (1 - F);
const E2 = F * (2 - F);
const E = Math.sqrt(E2);
const RAD = Math.PI / 180;

function qAuth(sinPhi) {
  const es = E * sinPhi;
  return (1 - E2) * (sinPhi / (1 - es * es) - (1 / (2 * E)) * Math.log((1 - es) / (1 + es)));
}
const QP = qAuth(1);
const R_AUTH2 = (A * A * QP) / 2; // raio autálico ao quadrado

// seno da latitude autálica: preserva a área do elipsoide numa esfera
function sinAuthalic(latDeg) {
  return qAuth(Math.sin(latDeg * RAD)) / QP;
}

function ringAreaSigned(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % n];
    let dLng = (p2[1] - p1[1]) * RAD;
    if (dLng > Math.PI) dLng -= 2 * Math.PI;
    else if (dLng < -Math.PI) dLng += 2 * Math.PI;
    sum += dLng * (sinAuthalic(p1[0]) + sinAuthalic(p2[0]));
  }
  return (sum * R_AUTH2) / 2;
}

/** Área em m² de um anel (não precisa repetir o primeiro ponto no fim). */
export function ringArea(ring) {
  return Math.abs(ringAreaSigned(ring));
}

/** Área em m² de um polígono, descontando os furos. */
export function polygonArea(outer, holes = []) {
  let a = ringArea(outer);
  for (const h of holes) a -= ringArea(h);
  return Math.max(0, a);
}

/** Distância geodésica em metros (Vincenty; cai para haversine se não convergir). */
export function distance(p1, p2) {
  if (p1[0] === p2[0] && p1[1] === p2[1]) return 0;
  const L = (p2[1] - p1[1]) * RAD;
  const U1 = Math.atan((1 - F) * Math.tan(p1[0] * RAD));
  const U2 = Math.atan((1 - F) * Math.tan(p2[0] * RAD));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
  let lambda = L, prev, iter = 0;
  let sinSigma, cosSigma, sigma, cosSqAlpha, cos2SigmaM;
  do {
    const sinL = Math.sin(lambda), cosL = Math.cos(lambda);
    sinSigma = Math.sqrt((cosU2 * sinL) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosL) ** 2);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinL) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    const C = (F / 16) * cosSqAlpha * (4 + F * (4 - 3 * cosSqAlpha));
    prev = lambda;
    lambda = L + (1 - C) * F * sinAlpha *
      (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
  } while (Math.abs(lambda - prev) > 1e-12 && ++iter < 200);
  if (iter >= 200) return haversine(p1, p2);
  const uSq = (cosSqAlpha * (A * A - B * B)) / (B * B);
  const AA = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const BB = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const dSigma = BB * sinSigma * (cos2SigmaM + (BB / 4) *
    (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
      (BB / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  return B * AA * (sigma - dSigma);
}

export function haversine(p1, p2) {
  const R = 6371008.8;
  const dLat = (p2[0] - p1[0]) * RAD, dLng = (p2[1] - p1[1]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(p1[0] * RAD) * Math.cos(p2[0] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Comprimento em metros de uma linha; closed=true soma o trecho de volta ao início. */
export function pathLength(coords, closed = false) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += distance(coords[i - 1], coords[i]);
  if (closed && coords.length > 2) d += distance(coords[coords.length - 1], coords[0]);
  return d;
}

/** Ponto para o rótulo: centroide se cair dentro do polígono, senão o vértice mais próximo dele. */
export function labelPoint(ring) {
  if (!ring.length) return null;
  if (ring.length < 3) return ring[0];
  const lat0 = ring[0][0], lng0 = ring[0][1];
  const k = Math.cos(lat0 * RAD);
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const x1 = (p[1] - lng0) * k, y1 = p[0] - lat0;
    const x2 = (q[1] - lng0) * k, y2 = q[0] - lat0;
    const cr = x1 * y2 - x2 * y1;
    a += cr; cx += (x1 + x2) * cr; cy += (y1 + y2) * cr;
  }
  if (Math.abs(a) < 1e-18) return ring[0];
  const c = [lat0 + cy / (3 * a), lng0 + cx / (3 * a) / k];
  if (pointInRing(c, ring)) return c;
  // centroide caiu fora (forma em L, em U...): usa o meio do trecho interno mais largo
  // na linha horizontal que passa pelo centroide
  for (const lat of [c[0], (bounds(ring)[0][0] + bounds(ring)[1][0]) / 2]) {
    const xs = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][0], yj = ring[j][0];
      if ((yi > lat) !== (yj > lat)) xs.push(ring[j][1] + ((lat - yj) / (yi - yj)) * (ring[i][1] - ring[j][1]));
    }
    xs.sort((p, q) => p - q);
    let best = null, w = 0;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] > w) { w = xs[i + 1] - xs[i]; best = [lat, (xs[i] + xs[i + 1]) / 2]; }
    }
    if (best) return best;
  }
  return ring[0];
}

export function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
    if ((yi > pt[0]) !== (yj > pt[0]) && pt[1] < ((xj - xi) * (pt[0] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Caixa envolvente [[latMin,lngMin],[latMax,lngMax]] de uma lista de coordenadas. */
export function bounds(coordsList) {
  let s = 90, w = 180, n = -90, e = -180, any = false;
  for (const c of coordsList) {
    any = true;
    if (c[0] < s) s = c[0];
    if (c[0] > n) n = c[0];
    if (c[1] < w) w = c[1];
    if (c[1] > e) e = c[1];
  }
  return any ? [[s, w], [n, e]] : null;
}

// ---------- unidades e formatação ----------

export const SECONDARY_UNITS = {
  none: { label: 'Nenhuma', m2: 0, abbr: '' },
  tarefa_ba: { label: 'Tarefa baiana (4.356 m²)', m2: 4356, abbr: 'tarefas' },
  alq_paulista: { label: 'Alqueire paulista (2,42 ha)', m2: 24200, abbr: 'alq. paulista' },
  alq_mineiro: { label: 'Alqueire mineiro/goiano (4,84 ha)', m2: 48400, abbr: 'alq. mineiro' },
  alq_baiano: { label: 'Alqueire baiano (9,68 ha)', m2: 96800, abbr: 'alq. baiano' },
  m2: { label: 'Metros quadrados', m2: 1, abbr: 'm²' }
};

function num(v, dec) {
  return v.toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export function fmtHa(m2) {
  const ha = m2 / 10000;
  return num(ha, ha < 10 ? 4 : 2) + ' ha';
}

export function fmtArea(m2, secondary = 'none') {
  const base = fmtHa(m2);
  const u = SECONDARY_UNITS[secondary];
  if (!u || !u.m2) return base;
  const v = m2 / u.m2;
  return `${base} (${num(v, u.m2 === 1 ? 0 : 2)} ${u.abbr})`;
}

export function fmtDist(m) {
  if (m >= 10000) return num(m / 1000, 2) + ' km';
  return num(m, m < 100 ? 1 : 0) + ' m';
}

/**
 * Quanto do rótulo cabe no zoom atual: 0 = esconde, 1 = só o nome, 2 = nome e medida.
 * kind: 'polygon' | 'line' | 'point'. px: menor lado do polígono ou comprimento da linha, em pixels de tela.
 */
export function labelLevel(kind, px, zoom) {
  if (kind === 'polygon') return px < 28 ? 0 : px < 80 ? 1 : 2;
  if (kind === 'line') return zoom < 15 || px < 80 ? 0 : px < 150 ? 1 : 2;
  return zoom < 16 ? 0 : 2;
}
