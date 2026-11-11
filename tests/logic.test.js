import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { ringArea, polygonArea, distance, pathLength, labelPoint, pointInRing, fmtHa, fmtArea, fmtDist } from '../src/geo.js';
import {
  emptyDb, normalizeDb, addFolder, removeFolder, descendantIds, itemsDeep, folderTotals,
  exportTree, importTree, canMoveFolder, isVisible, folderPath, safeFileName, itemArea, itemLength
} from '../src/model.js';
import { buildKml, parseKml, toKmlColor, fromKmlColor, countTree } from '../src/kml.js';

const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol})`);

test('distância: caso de referência do Vincenty (Flinders Peak -> Buninyong)', () => {
  const d = distance([-37.95103341666667, 144.42486788888888], [-37.65282113888889, 143.92649552777777]);
  close(d, 54972.271, 0.01);
});

test('distância: 1 grau de longitude no equador', () => {
  close(distance([0, 0], [0, 1]), 111319.491, 0.01);
});

test('área: célula 1x1 grau confere com integração numérica do elipsoide', () => {
  const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f);
  const cell = (lat0) => {
    let s = 0; const n = 20000, d = (Math.PI / 180) / n;
    for (let i = 0; i < n; i++) {
      const phi = (lat0 * Math.PI) / 180 + (i + 0.5) * d;
      const w = 1 - e2 * Math.sin(phi) ** 2;
      s += ((a * a * (1 - e2)) / (w * w)) * Math.cos(phi) * d;
    }
    return s * (Math.PI / 180);
  };
  for (const lat0 of [0, -13, -30]) {
    const ring = [[lat0, -40], [lat0, -39], [lat0 + 1, -39], [lat0 + 1, -40]];
    const got = ringArea(ring), ref = cell(lat0);
    assert.ok(Math.abs(got - ref) / ref < 1e-9, `lat ${lat0}: ${got} vs ${ref}`);
  }
});

test('área: quadrado de 100 m x 100 m na Bahia dá 1 ha', () => {
  const lat = -12.5, lng = -39.2;
  // passos em graus calibrados pela própria distância geodésica
  const dLat = 100 / distance([lat, lng], [lat + 1, lng]);
  const dLng = 100 / distance([lat, lng], [lat, lng + 1]);
  const ring = [[lat, lng], [lat, lng + dLng], [lat + dLat, lng + dLng], [lat + dLat, lng]];
  close(ringArea(ring), 10000, 1.5);
  close(pathLength(ring, true), 400, 0.05);
  // sentido horário ou anti-horário dá a mesma área
  close(ringArea([...ring].reverse()), ringArea(ring), 1e-6);
});

test('área: furo é descontado', () => {
  const outer = [[-12, -39], [-12, -38.99], [-11.99, -38.99], [-11.99, -39]];
  const hole = [[-11.997, -38.997], [-11.997, -38.993], [-11.993, -38.993], [-11.993, -38.997]];
  close(polygonArea(outer, [hole]), ringArea(outer) - ringArea(hole), 1e-6);
  assert.ok(polygonArea(outer, [hole]) < ringArea(outer));
});

test('rótulo: fica dentro do polígono, inclusive em forma de L', () => {
  const L = [[0, 0], [0, 0.03], [0.01, 0.03], [0.01, 0.01], [0.03, 0.01], [0.03, 0]];
  assert.ok(pointInRing(labelPoint(L), L));
  const U = [[0, 0], [0, 0.03], [0.03, 0.03], [0.03, 0.02], [0.01, 0.02], [0.01, 0.01], [0.03, 0.01], [0.03, 0]];
  assert.ok(pointInRing(labelPoint(U), U));
  const sq = [[0, 0], [0, 1], [1, 1], [1, 0]];
  const c = labelPoint(sq);
  close(c[0], 0.5, 1e-6); close(c[1], 0.5, 1e-6);
});

test('formatação pt-BR', () => {
  assert.equal(fmtHa(12345.6), '1,2346 ha');
  assert.equal(fmtHa(1234567), '123,46 ha');
  assert.equal(fmtArea(43560, 'tarefa_ba'), '4,3560 ha (10,00 tarefas)');
  assert.equal(fmtDist(57.33), '57,3 m');
  assert.equal(fmtDist(1234.4), '1.234 m');
  assert.equal(fmtDist(12345), '12,35 km');
});

test('cores KML: ida e volta (aabbggrr)', () => {
  assert.equal(toKmlColor('#ff0000', 1), 'ff0000ff');
  assert.equal(toKmlColor('#11ffcc', 0.5), '80ccff11');
  assert.deepEqual(fromKmlColor('7f0000ff'), { hex: '#ff0000', opacity: 0.5 });
  assert.equal(fromKmlColor('zz'), null);
  const back = fromKmlColor(toKmlColor('#3b78e7', 0.35));
  assert.equal(back.hex, '#3b78e7'); close(back.opacity, 0.35, 0.01);
});

function sampleDb() {
  const db = emptyDb();
  const faz = addFolder(db, 'Fazenda Teste');
  const r1 = addFolder(db, 'Retiro 1', faz.id);
  const r2 = addFolder(db, 'Retiro 2 & <Sede>', faz.id);
  const outra = addFolder(db, 'Outra fazenda');
  const sq = (lat, lng) => [[lat, lng], [lat, lng + 0.002], [lat + 0.002, lng + 0.002], [lat + 0.002, lng]];
  db.items.push(
    { id: 'a', folderId: r1.id, type: 'polygon', name: 'Pasto 1', coords: sq(-12.5, -39.2),
      style: { stroke: '#ff0000', strokeOpacity: 1, width: 4, fill: '#00ff00', fillOpacity: 0.4 } },
    { id: 'b', folderId: r1.id, type: 'polygon', name: 'Pasto 2', coords: sq(-12.5, -39.197),
      style: { stroke: '#ff0000', strokeOpacity: 1, width: 4, fill: '#00ff00', fillOpacity: 0.4 } },
    { id: 'c', folderId: r2.id, type: 'polygon', name: 'Pasto 3', coords: sq(-12.497, -39.2),
      holes: [[[-12.4965, -39.1995], [-12.4965, -39.199], [-12.496, -39.199], [-12.496, -39.1995]]],
      style: { stroke: '#0000ff', strokeOpacity: 0.8, width: 2, fill: '#0000ff', fillOpacity: 0 } },
    { id: 'd', folderId: r2.id, type: 'line', name: 'Cerca nova', coords: [[-12.5, -39.2], [-12.498, -39.199], [-12.497, -39.197]],
      style: { stroke: '#ffffff', strokeOpacity: 1, width: 3 } },
    { id: 'e', folderId: faz.id, type: 'point', name: 'Bebedouro 1', coords: [[-12.499, -39.199]], icon: 'blue', desc: 'bóia 2"' },
    { id: 'f', folderId: outra.id, type: 'polygon', name: 'Fora', coords: sq(-13, -40), style: {} },
    { id: 'g', folderId: null, type: 'point', name: 'Solto', coords: [[-12, -39]], icon: 'red' }
  );
  return { db, faz, r1, r2, outra };
}

test('pastas: descendentes, totais, exclusão em cascata e movimento', () => {
  const { db, faz, r1, r2, outra } = sampleDb();
  assert.deepEqual(descendantIds(db, faz.id).sort(), [faz.id, r1.id, r2.id].sort());
  assert.equal(itemsDeep(db, faz.id).length, 5);
  assert.equal(folderTotals(db, faz.id).count, 5);
  close(folderTotals(db, r1.id).area, itemArea(db.items[0]) + itemArea(db.items[1]), 1e-6);
  assert.equal(folderTotals(db, null).count, 7);
  assert.equal(canMoveFolder(db, faz.id, r1.id), false);
  assert.equal(canMoveFolder(db, r1.id, outra.id), true);
  assert.equal(folderPath(db, r1.id), 'Fazenda Teste / Retiro 1');
  faz.visible = false;
  assert.equal(isVisible(db, db.items[0]), false);
  assert.equal(isVisible(db, db.items[5]), true);
  db.activeFolder = r1.id;
  removeFolder(db, faz.id);
  assert.equal(db.folders.length, 1);
  assert.deepEqual(db.items.map(i => i.id), ['f', 'g']);
  assert.equal(db.activeFolder, null);
});

test('KML: exporta a pasta inteira com subpastas e reimporta igual', () => {
  const { db, faz } = sampleDb();
  const kml = buildKml(exportTree(db, faz.id), { descArea: true, secondary: 'none' });

  // estrutura: Document > Folder(Fazenda) > Folder(Retiro 1), Folder(Retiro 2)
  const doc = new DOMParser().parseFromString(kml, 'text/xml');
  assert.equal(doc.getElementsByTagName('Folder').length, 3);
  assert.equal(doc.getElementsByTagName('Placemark').length, 5);
  assert.ok(!kml.includes('Fora'), 'não deve levar item de outra pasta');
  assert.ok(kml.includes('Retiro 2 &amp; &lt;Sede&gt;'));
  assert.ok(kml.includes('http://maps.google.com/mapfiles/ms/icons/blue.png'));
  assert.ok(!kml.includes('shapes/water.png'));
  // 2 pastos com o mesmo estilo compartilham um Style só
  assert.equal(doc.getElementsByTagName('Style').length, 4);
  assert.ok(kml.includes('<color>6600ff00</color>'), 'preenchimento verde 40%');
  assert.ok(kml.includes('<color>ff0000ff</color>'), 'contorno vermelho opaco');
  assert.ok(/Área: 4,8\d+ ha \| Perímetro: 877 m/.test(kml), kml.match(/Área:[^<]*/)?.[0]);

  const tree = parseKml(kml, DOMParser);
  assert.equal(tree.name, 'Fazenda Teste');
  assert.equal(countTree(tree), 5);
  assert.deepEqual(tree.folders.map(f => f.name), ['Retiro 1', 'Retiro 2 & <Sede>']);
  const p1 = tree.folders[0].items[0];
  assert.equal(p1.name, 'Pasto 1');
  assert.deepEqual(p1.style, { stroke: '#ff0000', strokeOpacity: 1, width: 4, fill: '#00ff00', fillOpacity: 0.4 });
  close(itemArea(p1), itemArea(db.items[0]), 0.01);
  const p3 = tree.folders[1].items[0];
  assert.equal(p3.holes.length, 1);
  assert.equal(p3.style.fillOpacity, 0);
  close(p3.style.strokeOpacity, 0.8, 0.01);
  close(itemArea(p3), itemArea(db.items[2]), 0.01);
  const cerca = tree.folders[1].items[1];
  assert.equal(cerca.type, 'line');
  close(itemLength(cerca), itemLength(db.items[3]), 0.01);
  const beb = tree.items[0];
  assert.equal(beb.icon, 'blue');
  assert.equal(beb.desc, 'bóia 2"');
  assert.equal(p1.desc, '', 'a linha automática de área não vira descrição duplicada');

  // pasta com uma única subpasta e nenhum item solto mantém os dois níveis
  const { db: db3, faz: faz3, r1: r13 } = sampleDb();
  db3.items = db3.items.filter(i => i.folderId === r13.id);
  db3.folders = db3.folders.filter(f => f.id === faz3.id || f.id === r13.id);
  const t3 = parseKml(buildKml(exportTree(db3, faz3.id)), DOMParser);
  assert.equal(t3.name, 'Fazenda Teste');
  assert.deepEqual(t3.folders.map(f => f.name), ['Retiro 1']);
  assert.equal('wrapper' in t3, false);

  // importar de volta para o banco
  const db2 = emptyDb();
  const f = importTree(db2, tree);
  assert.equal(db2.folders.length, 3);
  assert.equal(itemsDeep(db2, f.id).length, 5);
  assert.equal(new Set(db2.items.map(i => i.id)).size, 5);
});

test('KML: exportar tudo inclui itens soltos e todas as pastas', () => {
  const { db } = sampleDb();
  const kml = buildKml(exportTree(db, null, 'Tudo'), { descArea: false });
  const doc = new DOMParser().parseFromString(kml, 'text/xml');
  assert.equal(doc.getElementsByTagName('Placemark').length, 7);
  assert.equal(doc.getElementsByTagName('Folder').length, 4);
  assert.ok(!kml.includes('Área:'));
});

test('KML: lê arquivo no formato do Google Earth (StyleMap, MultiGeometry, CascadingStyle)', () => {
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2" xmlns:kml="http://www.opengis.net/kml/2.2">
<Document><name>Faz.kml</name>
 <Style id="n"><LineStyle><color>ff00ffff</color><width>2.5</width></LineStyle><PolyStyle><color>4d00ffff</color></PolyStyle></Style>
 <Style id="h"><LineStyle><color>ff0000ff</color></LineStyle></Style>
 <StyleMap id="m"><Pair><key>normal</key><styleUrl>#n</styleUrl></Pair><Pair><key>highlight</key><styleUrl>#h</styleUrl></Pair></StyleMap>
 <gx:CascadingStyle kml:id="cs"><Style><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/shapes/water.png</href></Icon></IconStyle></Style></gx:CascadingStyle>
 <Folder><name>Pastos</name>
  <Placemark><name>P1</name><styleUrl>#m</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>
   -39.2,-12.5,0 -39.198,-12.5,0 -39.198,-12.498,0 -39.2,-12.498,0 -39.2,-12.5,0
  </coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
  <Placemark><name>Multi</name><Style><LineStyle><color>ffff0000</color><width>5</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>
   <MultiGeometry>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>-39.1,-12.5 -39.098,-12.5 -39.098,-12.498</coordinates></LinearRing></outerBoundaryIs></Polygon>
    <LineString><coordinates>-39.1,-12.5,0 -39.09,-12.49,0</coordinates></LineString>
   </MultiGeometry></Placemark>
  <Placemark><name>Agua</name><styleUrl>#cs</styleUrl><Point><coordinates>-39.15,-12.45,0</coordinates></Point></Placemark>
  <Placemark><name>Vazio</name></Placemark>
 </Folder>
</Document></kml>`;
  const t = parseKml(kml, DOMParser, 'Faz');
  assert.equal(t.name, 'Pastos');
  assert.equal(t.items.length, 4);
  const [p1, m1, m2, agua] = t.items;
  assert.equal(p1.coords.length, 4, 'anel sem o ponto repetido');
  assert.equal(p1.style.stroke, '#ffff00');
  assert.equal(p1.style.width, 2.5);
  close(p1.style.fillOpacity, 0.3, 0.01);
  assert.equal(m1.name, 'Multi (1)'); assert.equal(m1.type, 'polygon');
  assert.equal(m1.style.stroke, '#0000ff'); assert.equal(m1.style.fillOpacity, 0);
  assert.equal(m2.type, 'line'); assert.equal(m2.style.width, 5);
  assert.equal(agua.icon, 'blue', 'ícone de ondas vira a gota azul');
});

test('KML: arquivo inválido ou vazio dá erro claro', () => {
  assert.throws(() => parseKml('<kml><Document><name>x</name></Document></kml>', DOMParser), /Nenhuma medição/);
});

test('banco: normalização tolera dados quebrados', () => {
  const db = normalizeDb({ folders: [{ id: 'x', name: 'A', parentId: 'sumiu' }], items: [{ id: 'i', folderId: 'nada', type: 'point', coords: [[0, 0]] }], activeFolder: 'zzz', settings: { base: 'osm' } });
  assert.equal(db.folders[0].parentId, null);
  assert.equal(db.items[0].folderId, null);
  assert.equal(db.activeFolder, null);
  assert.equal(db.settings.base, 'osm');
  assert.equal(db.settings.gpsMinDist, 3);
  assert.equal(normalizeDb(null).folders.length, 0);
  assert.equal(safeFileName('Fazenda São José / Retiro 1'), 'Fazenda_Sao_Jose_Retiro_1');
});
