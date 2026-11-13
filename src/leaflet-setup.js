// O plugin de rotação lê o Leaflet de globalThis.L; este módulo precisa ser importado antes dele.
import L from 'leaflet';
globalThis.L = L;
export default L;
