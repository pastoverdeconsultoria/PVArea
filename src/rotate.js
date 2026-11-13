import L from './leaflet-setup.js';
import 'leaflet-rotate';

/**
 * O leaflet-rotate gira o mapa a cada pinça, mesmo quando a pessoa só quer dar zoom.
 * Aqui a rotação só começa depois que os dois dedos giram mais de ROT_LIMIAR graus,
 * e começa sem salto (a partir do ângulo em que o mapa está).
 */
export const ROT_LIMIAR = 14;

function rawDelta(tg, e) {
  const t0 = e.touches[0], t1 = e.touches[1];
  const vx = t0.clientX - t1.clientX, vy = t0.clientY - t1.clientY;
  let d = (Math.atan(vx / vy) - tg._startTheta) * (180 / Math.PI);
  if (vy < 0) d += 180;
  return d;
}

const TG = L.Map.TouchGestures && L.Map.TouchGestures.prototype;
if (TG && !TG.__pvPatched) {
  TG.__pvPatched = true;
  const start = TG._onTouchStart, move = TG._onTouchMove, end = TG._onTouchEnd;
  TG._onTouchStart = function (e) {
    start.call(this, e);
    this._pvWant = !!this._rotating && e.touches && e.touches.length === 2;
    this._pvOn = false;
    if (this._pvWant) { this._rotating = false; this._pvRef = rawDelta(this, e); }
  };
  TG._onTouchMove = function (e) {
    if (this._pvWant && !this._pvOn && e.touches && e.touches.length === 2 && this._gesture) {
      const raw = rawDelta(this, e);
      const ang = ((raw - this._pvRef) % 360 + 540) % 360 - 180;
      if (Math.abs(ang) >= ROT_LIMIAR) {
        this._pvOn = true;
        this._rotating = true;
        this._startBearing = this._map.getBearing() + raw;
      }
    }
    return move.call(this, e);
  };
  TG._onTouchEnd = function (e) {
    this._pvWant = this._pvOn = false;
    return end.call(this, e);
  };
}

export default L;
