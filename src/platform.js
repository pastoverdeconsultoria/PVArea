// Ponte com o Android (Capacitor). No navegador tudo tem um equivalente simples,
// o que permite testar a interface fora do celular.

import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Geolocation } from '@capacitor/geolocation';
import { App } from '@capacitor/app';
import { KeepAwake } from '@capacitor-community/keep-awake';

export const isNative = Capacitor.isNativePlatform();

const DB_KEY = 'pvarea.db.v1';
const DB_FILE = 'pvarea-db.json';
let saveTimer = null;

export async function loadDb() {
  try {
    const s = localStorage.getItem(DB_KEY);
    if (s) return JSON.parse(s);
  } catch { /* segue para o arquivo */ }
  if (isNative) {
    try {
      const r = await Filesystem.readFile({ path: DB_FILE, directory: Directory.Data, encoding: Encoding.UTF8 });
      return JSON.parse(r.data);
    } catch { /* primeira execução */ }
  }
  return null;
}

/** Grava no armazenamento do WebView e, no celular, também num arquivo (cópia de segurança). */
export function saveDb(db) {
  const json = JSON.stringify(db);
  let ok = true;
  try { localStorage.setItem(DB_KEY, json); } catch { ok = false; }
  if (isNative) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      Filesystem.writeFile({ path: DB_FILE, directory: Directory.Data, encoding: Encoding.UTF8, data: json })
        .catch(() => {});
    }, ok ? 800 : 0);
  }
  return ok || isNative;
}

function b64ToBlob(b64, mime) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/** file = { name, mime, text } ou { name, mime, base64 } */
export async function shareFile(file) {
  if (!isNative) {
    const blob = file.base64 != null ? b64ToBlob(file.base64, file.mime) : new Blob([file.text], { type: file.mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    return { shared: true };
  }
  const opts = { path: 'exportar/' + file.name, directory: Directory.Cache, recursive: true };
  if (file.base64 != null) opts.data = file.base64;
  else { opts.data = file.text; opts.encoding = Encoding.UTF8; }
  const res = await Filesystem.writeFile(opts);
  try {
    await Share.share({ title: file.name, files: [res.uri], dialogTitle: 'Enviar ' + file.name });
  } catch (e) {
    if (!/cancel/i.test(String(e && e.message))) throw e;
  }
  return { shared: true };
}

/** Salva em Documentos/PVArea no celular. Devolve o caminho mostrado ao usuário. */
export async function saveToDocuments(file) {
  if (!isNative) { await shareFile(file); return 'Downloads/' + file.name; }
  const opts = { path: 'PVArea/' + file.name, directory: Directory.Documents, recursive: true };
  if (file.base64 != null) opts.data = file.base64;
  else { opts.data = file.text; opts.encoding = Encoding.UTF8; }
  await Filesystem.writeFile(opts);
  return 'Documentos/PVArea/' + file.name;
}

/**
 * Acompanha o GPS. onFix({lat,lng,acc}) a cada posição; onError(mensagem).
 * Devolve uma função que encerra o acompanhamento.
 */
export async function watchGps(onFix, onError) {
  if (isNative) {
    try {
      let perm = await Geolocation.checkPermissions();
      if (perm.location !== 'granted') perm = await Geolocation.requestPermissions({ permissions: ['location'] });
      if (perm.location !== 'granted') { onError('Permissão de localização negada'); return () => {}; }
    } catch {
      onError('Ligue a localização (GPS) do celular');
      return () => {};
    }
    const id = await Geolocation.watchPosition(
      { enableHighAccuracy: true, timeout: 30000, maximumAge: 0, minimumUpdateInterval: 1000, interval: 1000 },
      (pos, err) => {
        if (err || !pos) { onError('Sem sinal de GPS'); return; }
        onFix({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy });
      }
    );
    return () => { Geolocation.clearWatch({ id }).catch(() => {}); };
  }
  if (!navigator.geolocation) { onError('GPS indisponível neste aparelho'); return () => {}; }
  const id = navigator.geolocation.watchPosition(
    p => onFix({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
    () => onError('Sem sinal de GPS'),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
  );
  return () => navigator.geolocation.clearWatch(id);
}

export function keepAwake(on) {
  if (!isNative) return;
  (on ? KeepAwake.keepAwake() : KeepAwake.allowSleep()).catch(() => {});
}

export function onBackButton(handler) {
  if (!isNative) return;
  App.addListener('backButton', () => { if (!handler()) App.exitApp(); });
}
