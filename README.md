# PV Área

Aplicativo Android da Pasto Verde Consultoria para medir áreas, distâncias e pontos no mapa
e gerar KML/KMZ com pastas, como o Google Earth do computador.

- Medição por toque no mapa ou caminhando com o GPS, com hectares e perímetro ao vivo.
- Pastas e subpastas: toda medição vai para a pasta ativa.
- Exporta a pasta inteira (com subpastas) em um único KML ou KMZ.
- Cor, espessura e transparência do contorno e do preenchimento, por medição ou para a pasta toda.
- Importa KML/KMZ existentes mantendo pastas e cores.
- Imagem de satélite da Esri guardada no celular depois de vista, para uso sem sinal.

## Baixar o APK

https://github.com/pastoverdeconsultoria/PVArea/releases/latest/download/pv-area.apk

Cada envio para o branch `main` compila e publica uma versão nova (GitHub Actions).
As versões novas instalam por cima da anterior sem perder as medições.

## Desenvolvimento

```
npm install
npm test        # cálculo de área/distância, pastas e KML
npm run dev     # interface no navegador
```

Base: Capacitor + Vite + Leaflet. A lógica fica em `src/geo.js`, `src/model.js` e `src/kml.js`.
