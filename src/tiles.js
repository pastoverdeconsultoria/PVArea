// Camadas de mapa. As imagens da Esri e do OpenStreetMap ficam guardadas no celular
// depois de vistas uma vez, para aparecerem sem sinal. As do Google não são guardadas
// (os termos de uso não permitem).

import L from 'leaflet';

const DB_NAME = 'pvarea-tiles';
const STORE = 'tiles';
const MAX_TILES = 12000;
const PRUNE = 2500;
let dbPromise = null;
let writes = 0;

function idb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const os = req.result.createObjectStore(STORE, { keyPath: 'k' });
        os.createIndex('t', 't');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(() => null);
  }
  return dbPromise;
}

async function getTile(k) {
  const db = await idb();
  if (!db) return null;
  return new Promise(res => {
    const r = db.transaction(STORE).objectStore(STORE).get(k);
    r.onsuccess = () => res(r.result ? r.result.b : null);
    r.onerror = () => res(null);
  });
}

async function putTile(k, blob) {
  const db = await idb();
  if (!db) return;
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put({ k, b: blob, t: Date.now() });
    if (++writes % 400 === 0) prune(db);
  } catch { /* cota cheia: segue sem guardar */ }
}

function prune(db) {
  const os = db.transaction(STORE, 'readwrite').objectStore(STORE);
  const c = os.count();
  c.onsuccess = () => {
    if (c.result <= MAX_TILES) return;
    let left = c.result - MAX_TILES + PRUNE;
    os.index('t').openCursor().onsuccess = e => {
      const cur = e.target.result;
      if (cur && left-- > 0) { cur.delete(); cur.continue(); }
    };
  };
}

export async function cachedTileCount() {
  const db = await idb();
  if (!db) return 0;
  return new Promise(res => {
    const r = db.transaction(STORE).objectStore(STORE).count();
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(0);
  });
}

export async function clearTileCache() {
  const db = await idb();
  if (!db) return;
  return new Promise(res => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => res();
    tx.onerror = () => res();
  });
}

const CachedLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const img = document.createElement('img');
    img.alt = '';
    img.setAttribute('role', 'presentation');
    const url = this.getTileUrl(coords);
    const key = `${this.options.cacheId}/${coords.z}/${coords.x}/${coords.y}`;
    const finish = (blob) => {
      const obj = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(obj); done(null, img); };
      img.onerror = () => { URL.revokeObjectURL(obj); done(new Error('tile'), img); };
      img.src = obj;
    };
    getTile(key).then(hit => {
      if (hit) return finish(hit);
      return fetch(url, { mode: 'cors' })
        .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.blob(); })
        .then(blob => { putTile(key, blob); finish(blob); });
    }).catch(() => {
      // sem cache e sem rede (ou servidor sem CORS): tenta o carregamento normal da imagem
      img.onload = () => done(null, img);
      img.onerror = () => done(new Error('tile'), img);
      img.src = url;
    });
    return img;
  }
});

export const BASES = {
  esri: { label: 'Satélite (Esri)' },
  esri_hib: { label: 'Satélite com nomes (Esri)' },
  google: { label: 'Satélite Google (precisa de chave)' },
  google_hib: { label: 'Híbrido Google (precisa de chave)' },
  osm: { label: 'Mapa de ruas (OpenStreetMap)' }
};

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';

async function googleSession(key, hybrid) {
  const body = { mapType: 'satellite', language: 'pt-BR', region: 'BR' };
  if (hybrid) body.layerTypes = ['layerRoadmap'];
  const r = await fetch('https://tile.googleapis.com/v1/createSession?key=' + encodeURIComponent(key), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.session) throw new Error((j.error && j.error.message) || 'Chave do Google recusada');
  return j.session;
}

/** Devolve uma lista de camadas Leaflet para a base escolhida. */
export async function baseLayers(base, googleKey) {
  if (base === 'google' || base === 'google_hib') {
    if (!googleKey) throw new Error('Informe a chave do Google Maps nas configurações');
    const session = await googleSession(googleKey, base === 'google_hib');
    return [L.tileLayer(
      `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${session}&key=${encodeURIComponent(googleKey)}`,
      { maxZoom: 22, maxNativeZoom: 20, attribution: 'Imagens © Google' }
    )];
  }
  if (base === 'osm') {
    return [new CachedLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      { cacheId: 'osm', maxZoom: 22, maxNativeZoom: 19, attribution: '© OpenStreetMap' })];
  }
  const out = [new CachedLayer(ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { cacheId: 'esri', maxZoom: 22, maxNativeZoom: 19, attribution: 'Imagens © Esri, Maxar, Earthstar Geographics' })];
  if (base === 'esri_hib') {
    out.push(new CachedLayer(ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      { cacheId: 'esrilab', maxZoom: 22, maxNativeZoom: 19 }));
  }
  return out;
}
