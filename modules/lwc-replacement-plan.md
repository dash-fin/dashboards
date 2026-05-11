# Plan: Reemplazar TradingView Widget por Lightweight Charts

## Resumen de cambios

Se reemplaza el iframe embed de TradingView en el modal de chart de posiciones (`pfShowChart`) por **Lightweight Charts** (librería ligera de TradingView), usando `createPriceLine()` para dibujar las líneas Entry/SL/TP con precisión exacta.

---

## Cambio 1 — CSS: Eliminar `#pchOverlayLine` (obsoleto)

**Ubicación:** Líneas 163-170 en portafolio.html

**Antes (oldText):**
```css
/* ── Chart modal overlay ──────────────────────────────── */
#pchOverlayLine {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 3px;
  white-space: nowrap;
}
```

**Después (newText):**
```css
/* ── Chart modal (LWC) ────────────────────────────────── */
```

Nota: el bloque se reduce a un comentario placeholder para no dejar CSS huérfano.

---

## Cambio 2 — HTML: Reemplazar iframe + overlay div por un div vacío

**Ubicación:** Líneas ~4541-4543 en portafolio.html

**Antes (oldText):**
```html
    <!-- Chart wrap -->
    <div id="pchChartWrap" style="position:relative;padding:0">
      <iframe id="pchTvFrame" src="" style="width:100%;height:500px;border:none;display:block" allowfullscreen></iframe>
      <div id="pchOverlay" style="pointer-events:none;position:absolute;top:0;left:0;right:0;bottom:0;overflow:hidden"></div>
    </div>
```

**Después (newText):**
```html
    <!-- Chart wrap -->
    <div id="pchChartWrap" style="position:relative;padding:0">
      <div id="pchLwcContainer" style="width:100%;height:500px;"></div>
    </div>
```

---

## Cambio 3 — JS: Reemplazar función `buildTvWidget` por `buildLwcChart`

**Ubicación:** Reemplazar desde `function buildTvWidget(pos, entryPrice) {` hasta el `}` de cierre de esa función (excluyendo `buildDetailGrid` que sigue después).

**Antes (oldText):**
```javascript
function buildTvWidget(pos, entryPrice) {
  const symbol = getTvSymbol(pos);
  const src = `https://s.tradingview.com/widgetembed/?symbol=${symbol}&interval=D&theme=dark&style=1&locale=es&hideideas=1&toolbarbg=131322&allow_symbol_change=0&saveimage=0&studies=[]&no_sidebar=1&details=0&hotlist=0&calendar=0&news=0&range=12M&condateranges=0&height=500`;
  
  const iframe = document.getElementById('pchTvFrame');
  iframe.src = src;

  // Overlay lines
  const overlay = document.getElementById('pchOverlay');
  overlay.innerHTML = '';

  // Precio actual en la misma moneda que el entryPrice y el gráfico
  const esUsd = !!pos.ticker_adr;
  var preco;
  if (esUsd && pos.ticker_adr) {
    var adrPr = window.__pfAdrPrices[pos.ticker_adr];
    preco = adrPr ? adrPr.last : null;
  } else {
    preco = window.__pfPrices[pos.ticker_ars]?.last;
  }
  if (preco == null) return;

  const range = preco * 0.30;
  const priceHigh = preco + range;
  const priceLow = preco - range;

  function calcTop(price) {
    return 100 - ((price - priceLow) / (priceHigh - priceLow) * 80 + 10);
  }

  function createLine(price, label, color) {
    const top = calcTop(price);
    if (top < 0 || top > 100) return;
    const line = document.createElement('div');
    line.style.cssText = `position:absolute;top:${top}%;left:0;right:0;height:1px;background:${color};border-top:1px dashed ${color};`;
    const badge = document.createElement('span');
    badge.id = 'pchOverlayLine';
    badge.style.cssText = `position:absolute;left:8px;top:-10px;background:${color};color:#fff;padding:1px 6px;border-radius:3px;font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;white-space:nowrap;`;
    badge.textContent = `${label} $${Number(price).toFixed(2)}`;
    line.appendChild(badge);
    overlay.appendChild(line);
  }

  // Entry (violeta)
  createLine(entryPrice, 'ENTRY', '#7c7cf0');
  // SL (rojo)
  if (pos.stop_loss) {
    createLine(pos.stop_loss, 'SL', '#ef5350');
  }
  // TP (verde)
  if (pos.take_profit) {
    createLine(pos.take_profit, 'TP', '#26a69a');
  }
}
```

**Después (newText):**
```javascript
function buildLwcChart(pos, entryPrice) {
  const symbol = getTvSymbol(pos);
  const esUsd = !!pos.ticker_adr;
  const container = document.getElementById('pchLwcContainer');
  if (!container) return;

  // Crear chart con tema oscuro similar a TV
  const chart = LightweightCharts.createChart(container, {
    layout: {
      background: { type: 'solid', color: '#131322' },
      textColor: '#d1d4dc',
    },
    grid: {
      vertLines: { color: '#2a2a3e' },
      horzLines: { color: '#2a2a3e' },
    },
    crosshair: {
      mode: 0,
      vertLine: { color: '#7c7cf066', width: 1, style: 2, labelBackgroundColor: '#7c7cf0' },
      horzLine: { color: '#7c7cf066', width: 1, style: 2, labelBackgroundColor: '#7c7cf0' },
    },
    timeScale: {
      borderColor: '#2a2a4a',
      timeVisible: false,
      secondsVisible: false,
    },
    rightPriceScale: {
      borderColor: '#2a2a4a',
    },
    width: container.clientWidth,
    height: 500,
  });

  // Obtener datos históricos
  const rawData = window.pfSeriesData[symbol] || [];
  let seriesData = [];

  if (rawData.length > 0) {
    // Los datos vienen como [{fecha, cierre}], los convertimos a línea
    // Si en futuro hubiera OHLC, se puede cambiar a candlestick
    const sorted = [...rawData].sort((a,b) => a.fecha.localeCompare(b.fecha));
    seriesData = sorted.map(d => ({
      time: d.fecha,
      value: d.cierre,
    }));
  }

  // Crear series
  let mainSeries;
  if (seriesData.length >= 2) {
    mainSeries = chart.addLineSeries({
      color: '#7c7cf0',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#7c7cf0',
      crosshairMarkerBackgroundColor: '#131322',
    });
    mainSeries.setData(seriesData);
  } else {
    // Sin datos históricos: crear una serie invisible de soporte para las priceLines
    mainSeries = chart.addLineSeries({
      color: 'transparent',
      lineWidth: 0,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    // Poner dos puntos con el precio actual para que la escala funcione
    const now = new Date().toISOString().split('T')[0];
    const esUsd_ = !!pos.ticker_adr;
    const preco = esUsd_ && pos.ticker_adr
      ? (window.__pfAdrPrices[pos.ticker_adr]?.last ?? null)
      : (window.__pfPrices[pos.ticker_ars]?.last ?? null);
    if (preco) {
      const range = Math.max(entryPrice, preco) * 0.15;
      mainSeries.setData([
        { time: now, value: Math.min(entryPrice, preco) - range },
        { time: now, value: Math.max(entryPrice, preco) + range },
      ]);
    }
  }

  // Dibujar price lines: ENTRY, SL, TP
  function addPriceLine(price, label, color) {
    if (price == null) return;
    mainSeries.createPriceLine({
      price: price,
      color: color,
      lineWidth: 2,
      lineStyle: 2, // Dashed
      axisLabelVisible: true,
      title: label,
    });
  }

  addPriceLine(entryPrice, 'ENTRY', '#7c7cf0');
  if (pos.stop_loss) addPriceLine(pos.stop_loss, 'SL', '#ef5350');
  if (pos.take_profit) addPriceLine(pos.take_profit, 'TP', '#26a69a');

  // Ajustar escala al contenido
  chart.timeScale().fitContent();

  // ResizeObserver para responsividad
  const ro = new ResizeObserver(entries => {
    for (const entry of entries) {
      const { width } = entry.contentRect;
      chart.applyOptions({ width });
    }
  });
  ro.observe(container);

  // Guardar para cleanup
  window.__pchChart = chart;
  window.__pchResizeObserver = ro;
}
```

---

## Cambio 4 — JS: Reemplazar `buildTvWidget(pos, entryPrice)` por `buildLwcChart(pos, entryPrice)` dentro de `pfShowChart`

**Ubicación:** Línea ~4298 (única llamada dentro de `pfShowChart`)

**Antes (oldText):**
```javascript
  // 4. TradingView widget
  buildTvWidget(pos, entryPrice);
```

**Después (newText):**
```javascript
  // 4. Lightweight Charts
  buildLwcChart(pos, entryPrice);
```

---

## Cambio 5 — JS: Reemplazar `pfChartClose` para hacer cleanup de LWC en vez de iframe

**Ubicación:** Reemplazar la función `pfChartClose` completa (líneas ~4424-4437)

**Antes (oldText):**
```javascript
window.pfChartClose = function(event) {
  if (event && event.target && event.target.id !== 'pfChartOverlay') return;
  const overlay = document.getElementById('pfChartOverlay');
  if (overlay) {
    overlay.style.display = 'none';
    // Detener widget TV (liberar memoria)
    const iframe = document.getElementById('pchTvFrame');
    if (iframe) iframe.src = '';
    document.getElementById('pchOverlay').innerHTML = '';
  }
  _pfChartPosId = null;
};
```

**Después (newText):**
```javascript
window.pfChartClose = function(event) {
  if (event && event.target && event.target.id !== 'pfChartOverlay') return;
  const overlay = document.getElementById('pfChartOverlay');
  if (overlay) {
    overlay.style.display = 'none';
    // Limpiar Lightweight Charts
    if (window.__pchChart) {
      try { window.__pchChart.remove(); } catch(e) {}
      window.__pchChart = null;
    }
    if (window.__pchResizeObserver) {
      try { window.__pchResizeObserver.disconnect(); } catch(e) {}
      window.__pchResizeObserver = null;
    }
  }
  _pfChartPosId = null;
};
```

---

## Cambio 6 — HTML: Agregar CDN de Lightweight Charts al final del body

**Ubicación:** Justo antes de `</body>` en la línea 4557

**Antes (oldText):**
```html
</body>
```

**Después (newText):**
```html
<script src="https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.1/dist/lightweight-charts.standalone.production.min.js"></script>
</body>
```

---

## Orden de aplicación en Aider

1. **Cambio 1** — CSS: eliminar `#pchOverlayLine` (cambiar por comentario vacío)
2. **Cambio 6** — CDN: agregar script tag antes de `</body>`
3. **Cambio 2** — HTML: reemplazar iframe+overlay por `#pchLwcContainer`
4. **Cambio 3** — JS: reemplazar `buildTvWidget` por `buildLwcChart`
5. **Cambio 4** — JS: cambiar llamada a `buildTvWidget` por `buildLwcChart` dentro de `pfShowChart`
6. **Cambio 5** — JS: reemplazar `pfChartClose` con cleanup de LWC

---

## Código completo de la nueva función `buildLwcChart` (ready-to-paste)

```javascript
function buildLwcChart(pos, entryPrice) {
  const symbol = getTvSymbol(pos);
  const esUsd_ = !!pos.ticker_adr;
  const container = document.getElementById('pchLwcContainer');
  if (!container) return;

  // Crear chart con tema oscuro similar a TV
  const chart = LightweightCharts.createChart(container, {
    layout: {
      background: { type: 'solid', color: '#131322' },
      textColor: '#d1d4dc',
    },
    grid: {
      vertLines: { color: '#2a2a3e' },
      horzLines: { color: '#2a2a3e' },
    },
    crosshair: {
      mode: 0,
      vertLine: { color: '#7c7cf066', width: 1, style: 2, labelBackgroundColor: '#7c7cf0' },
      horzLine: { color: '#7c7cf066', width: 1, style: 2, labelBackgroundColor: '#7c7cf0' },
    },
    timeScale: {
      borderColor: '#2a2a4a',
      timeVisible: false,
      secondsVisible: false,
    },
    rightPriceScale: {
      borderColor: '#2a2a4a',
    },
    width: container.clientWidth,
    height: 500,
  });

  // Obtener datos históricos
  const rawData = window.pfSeriesData[symbol] || [];
  let seriesData = [];

  if (rawData.length > 0) {
    const sorted = [...rawData].sort((a,b) => a.fecha.localeCompare(b.fecha));
    seriesData = sorted.map(d => ({
      time: d.fecha,
      value: d.cierre,
    }));
  }

  // Crear series
  let mainSeries;
  if (seriesData.length >= 2) {
    mainSeries = chart.addLineSeries({
      color: '#7c7cf0',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#7c7cf0',
      crosshairMarkerBackgroundColor: '#131322',
    });
    mainSeries.setData(seriesData);
  } else {
    // Sin datos históricos: serie invisible de soporte para priceLines
    mainSeries = chart.addLineSeries({
      color: 'transparent',
      lineWidth: 0,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    const preco = esUsd_ && pos.ticker_adr
      ? (window.__pfAdrPrices[pos.ticker_adr]?.last ?? null)
      : (window.__pfPrices[pos.ticker_ars]?.last ?? null);
    if (preco) {
      const margin = Math.max(entryPrice, preco) * 0.15;
      const now = new Date().toISOString().split('T')[0];
      mainSeries.setData([
        { time: now, value: Math.min(entryPrice, preco) - margin },
        { time: now, value: Math.max(entryPrice, preco) + margin },
      ]);
    }
  }

  // Price lines: ENTRY, SL, TP
  function addPriceLine(price, label, color) {
    if (price == null) return;
    mainSeries.createPriceLine({
      price: price,
      color: color,
      lineWidth: 2,
      lineStyle: 2, // Dashed
      axisLabelVisible: true,
      title: label,
    });
  }

  addPriceLine(entryPrice, 'ENTRY', '#7c7cf0');
  if (pos.stop_loss) addPriceLine(pos.stop_loss, 'SL', '#ef5350');
  if (pos.take_profit) addPriceLine(pos.take_profit, 'TP', '#26a69a');

  chart.timeScale().fitContent();

  // ResizeObserver para responsividad
  const ro = new ResizeObserver(entries => {
    for (const entry of entries) {
      const { width } = entry.contentRect;
      chart.applyOptions({ width });
    }
  });
  ro.observe(container);

  window.__pchChart = chart;
  window.__pchResizeObserver = ro;
}
```

---

## Verificación post-aplicación

1. Abrir modal de chart → debe cargar LWC en vez de iframe de TV
2. ENTRY, SL, TP deben aparecer como líneas punteadas con label en el eje derecho
3. Cerrar modal → no debe quedar chart colgado en memoria
4. Reabrir otra posición → chart debe refrescar correctamente
5. Responsividad: hacer resize de la ventana → chart debe ajustar ancho
