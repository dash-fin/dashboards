#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Backfill Calendario PnL
#
# Rellena días faltantes en pnl_diario (fechas sin registro)
# consultando posiciones activas en portafolio y MEP histórico.
#
# Uso:
#   ./scripts/backfill_calendario.sh             # backfill automático desde el registro más antiguo
#   ./scripts/backfill_calendario.sh 2026-01-01  # desde una fecha específica
#
# ═══════════════════════════════════════════════════════════
set -euo pipefail

# ── Config ────────────────────────────────────────────────
SB_URL="https://endymbpdayeidromxayb.supabase.co"
# Usar la anon key (pública) para operaciones REST. Si se necesita service role
# para inserts, establecer SUPABASE_SR_KEY en el entorno o crontab.
SR_KEY="${SUPABASE_SR_KEY:-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVuZHltYnBkYXllaWRyb214YXliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MzU4NTAsImV4cCI6MjA4OTExMTg1MH0.BCZRvE9F1g_w2ffwj6NA6vyCYab2XcHDgmZir3CkeOk}"

HEADERS=(
  -H "apikey: ${SR_KEY}"
  -H "Authorization: Bearer ${SR_KEY}"
  -H "Content-Type: application/json"
  -H "Prefer: resolution=merge-duplicates,return=minimal"
)

ARG_TZ="America/Argentina/Buenos_Aires"
HOY=$(TZ="$ARG_TZ" date +%Y-%m-%d)

SINCE="${1:-}"

log() { echo "[$(TZ="$ARG_TZ" date '+%Y-%m-%d %H:%M:%S')] $*"; }

sb_get() {
  local table="$1" params="$2"
  curl -s -G "${SB_URL}/rest/v1/${table}" \
    -H "apikey: ${SR_KEY}" -H "Authorization: Bearer ${SR_KEY}" \
    --data-urlencode "${params}" \
    -H "Accept: application/json" 2>/dev/null
}

# ── 1. Determinar rango de fechas faltantes ──────────────────
log "📆 Determinando días faltantes..."

# Obtener fechas con MEP disponible (días en los que podemos calcular)
MEP_JSON=$(sb_get "mep_historico" "select=fecha,mep&order=fecha.asc&limit=50000")
if [ -z "$MEP_JSON" ] || [ "$MEP_JSON" = "[]" ]; then
  log "❌ No hay datos en mep_historico. No se puede calcular PnL sin cotización MEP."
  exit 1
fi

# Fecha más antigua de operaciones
MIN_DATE=$(sb_get "portafolio" "select=fecha_compra&order=fecha_compra.asc&limit=1&activo=eq.true" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['fecha_compra'] if d else '')" 2>/dev/null || echo "")

if [ -z "$MIN_DATE" ]; then
  log "❌ No hay posiciones activas en portafolio. Nada que backfillear."
  exit 0
fi

log "  Primer operación: $MIN_DATE"

# Determinar FROM: prioridad = argumento CLI > MIN_DATE
FROM_DATE="${SINCE:-$MIN_DATE}"

if [[ "$FROM_DATE" > "$HOY" ]]; then
  log "❌ Fecha desde ($FROM_DATE) es posterior a hoy ($HOY). Saliendo."
  exit 0
fi

# Obtener días ya registrados en pnl_diario
EXISTING_JSON=$(sb_get "pnl_diario" "select=fecha&user_email=eq.elyagui@gmail.com&fecha=gte.${FROM_DATE}&fecha=lte.${HOY}&order=fecha.asc&limit=50000")
declare -A EXISTING
while IFS= read -r f; do
  EXISTING["$f"]=1
done < <(echo "$EXISTING_JSON" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for r in d:
        if r.get('fecha'): print(r['fecha'])
except: pass
" 2>/dev/null || true)

log "  ${#EXISTING[@]} días ya registrados en pnl_diario"

# Construir mapa MEP: fecha → mep
declare -A MEP_MAP
while IFS='|' read -r f mep; do
  MEP_MAP["$f"]="$mep"
done < <(echo "$MEP_JSON" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for r in d:
        if r.get('fecha') and r.get('mep'):
            print(f\"{r['fecha']}|{r['mep']}\")
except: pass
" 2>/dev/null || true)

log "  ${#MEP_MAP[@]} días con MEP disponible"

# ── 2. Identificar días a procesar ──────────────────────────
log "🔍 Identificando días faltantes..."

# Generar la lista de días hábiles desde FROM_DATE hasta ayer (no hoy ni futuro)
AYER=$(TZ="$ARG_TZ" date -d "-1 day" +%Y-%m-%d)

declare -a MISSING_DAYS=()

# Iterar por cada día hábil que tiene MEP pero NO tiene pnl_diario
for fdy_key in $(echo "${!MEP_MAP[@]}" | tr ' ' '\n' | sort); do
  # Saltar si fuera del rango
  if [[ "$fdy_key" < "$FROM_DATE" || "$fdy_key" > "$AYER" ]]; then continue; fi
  # Saltar si ya existe
  if [ "${EXISTING[$fdy_key]:-}" = "1" ]; then continue; fi
  # Saltar findes (solo días hábiles bursátiles)
  local_dow=$(TZ="$ARG_TZ" date -d "$fdy_key" +%u 2>/dev/null || echo "0")
  if [ "$local_dow" -ge 6 ]; then continue; fi

  MISSING_DAYS+=("$fdy_key")
done

log "  ${#MISSING_DAYS[@]} días faltantes a procesar"

if [ ${#MISSING_DAYS[@]} -eq 0 ]; then
  log "✅ No hay días faltantes. Todo al día."
  exit 0
fi

# ── 3. Cargar posiciones activas + trades ───────────────────
log "📦 Cargando posiciones..."

# Posiciones activas del portafolio (NO opciones)
POS_JSON=$(sb_get "portafolio" "select=ticker_ars,tipo,cantidad,fecha_compra&activo=eq.true&tipo=neq.OPCION&limit=50000")

# Trades CEDEAR (multi-día con cierre > HOY y los ya cerrados)
TRADES_JSON=$(sb_get "trades" "select=ticker_ars,cantidad,fecha_apertura,fecha_cierre,ganancia_usd&user_email=eq.elyagui@gmail.com&tipo=eq.CEDEAR&limit=50000")

# Trades CEDEAR intradía (abiertos y cerrados el mismo día)
INTRADAY_JSON=$(sb_get "trades" "select=fecha_apertura,ganancia_usd&user_email=eq.elyagui@gmail.com&tipo=eq.CEDEAR&fecha_apertura=eq.fecha_cierre&limit=50000")

log "  Posiciones capturadas y listas."

# ── 4. Calcular por día usando Node (lógica compleja requiere JS) ──
# La lógica de cálculo de PnL es idéntica a la de monitor_dashboard.sh
# pero itera sobre días pasados en vez de solo hoy.
#
# Para simplificar: tenemos MEP por día y posiciones activas desde fecha_compra.
# Valor_usd ≈ Σ(qty * precio_ars) / (factor_bonos * MEP)
# PnL = (valor_usd - valor_usd_anterior) + ganancias_realizadas + intradía
# 
# Usamos la misma lógica que backfill_pnl_full.cjs pero simplificada:
# solo días con MEP, sin precios históricos complejos.

log "🔢 Calculando PnL para ${#MISSING_DAYS[@]} días usando node..."

# Exportar datos para node
export MISSING_DAYS_JSON=$(python3 -c "import json; d='${MISSING_DAYS[*]}'; print(json.dumps(d.split()))")
export POS_JSON TRADES_JSON INTRADAY_JSON MEP_JSON SB_URL SR_KEY

node -e "
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SB_URL, process.env.SR_KEY);

const BONOS = ['BONO_SOBERANO','DOLAR_LINKED','BONO_CER','BONO_DUAL'];

// Parsear datos exportados
const missingDays = JSON.parse(process.env.MISSING_DAYS_JSON || '[]');
const posAll = JSON.parse(process.env.POS_JSON || '[]');
const tradesAll = JSON.parse(process.env.TRADES_JSON || '[]');
const intradayAll = JSON.parse(process.env.INTRADAY_JSON || '[]');
const mepRows = JSON.parse(process.env.MEP_JSON || '[]');

// Construir MEP map
const mepByDate = {};
mepRows.forEach(r => { if (r.fecha && r.mep > 0) mepByDate[r.fecha] = Number(r.mep); });

// Obtener precios históricos para todos los tickers (desde el día más antiguo hasta ayer)
const tickers = [...new Set([
  ...posAll.map(p => p.ticker_ars),
  ...tradesAll.filter(t => t.ticker_ars).map(t => t.ticker_ars)
])].filter(Boolean);

if (!tickers.length) { console.log('❌ Sin tickers para calcular'); process.exit(0); }

// Construir portafolio timeline
const sortedDays = missingDays.sort();
const firstDay = sortedDays[0];
const lastDay = sortedDays[sortedDays.length - 1];

// Cargar precio de referencia inicial (día anterior al firstDay)
const prevDay = new Date(firstDay);
prevDay.setDate(prevDay.getDate() - 1);
const prevStr = prevDay.toISOString().split('T')[0];

// Precios históricos vía edge function
const main = async () => {
  const hdrs = {
    'Content-Type': 'application/json',
    apikey: process.env.SR_KEY,
    Authorization: 'Bearer ' + process.env.SR_KEY,
  };

  // Yahoo history + Rava series
  const [yhRes, rvRes] = await Promise.all([
    fetch(process.env.SB_URL + '/functions/v1/yahoo-prices', {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({ mode: 'yahoo-history', symbols: tickers.map(t => t + '.BA'), startDate: prevStr })
    }),
    fetch(process.env.SB_URL + '/functions/v1/yahoo-prices', {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({ mode: 'rava-series', symbols: tickers })
    }),
  ]);

  const yh = yhRes.ok ? await yhRes.json() : {};
  const rv = rvRes.ok ? await rvRes.json() : {};

  // Price index: ticker → { fecha: close }
  const priceByTk = {};
  for (const tk of tickers) {
    priceByTk[tk] = {};
    const yhRows = yh[tk + '.BA'] || [];
    const rvRows = rv[tk] || [];
    // Yahoo tiene prioridad
    if (yhRows.length >= 5) {
      yhRows.forEach(r => { priceByTk[tk][r.fecha] = r.close; });
      rvRows.forEach(r => { if (!priceByTk[tk][r.fecha]) priceByTk[tk][r.fecha] = r.cierre; });
    } else {
      rvRows.forEach(r => { priceByTk[tk][r.fecha] = r.cierre; });
    }
  }

  // Obtener valor de referencia (último registro en pnl_diario antes del primer día faltante)
  const prevPnL = await sb.from('pnl_diario')
    .select('fecha,valor_usd')
    .eq('user_email', 'elyagui@gmail.com')
    .lt('fecha', firstDay)
    .order('fecha', { ascending: false })
    .limit(1);

  let prevValorUsd = null;
  let prevPnlCheck = null;
  if (prevPnL.data && prevPnL.data.length > 0) {
    prevValorUsd = Number(prevPnL.data[0].valor_usd);
    prevPnlCheck = prevPnL.data[0].fecha;
  }

  // Realized gains por fecha
  const realizedByDate = {};
  tradesAll.filter(t => t.fecha_cierre && t.fecha_apertura && t.fecha_apertura < t.fecha_cierre && t.ganancia_usd != null)
    .forEach(t => { realizedByDate[t.fecha_cierre] = (realizedByDate[t.fecha_cierre]||0) + Number(t.ganancia_usd); });

  // Intraday gains por fecha
  const intradayByDate = {};
  intradayAll.filter(t => t.fecha_apertura && t.ganancia_usd != null)
    .forEach(t => { intradayByDate[t.fecha_apertura] = (intradayByDate[t.fecha_apertura]||0) + Number(t.ganancia_usd); });

  // Posiciones que se cierran en algún momento (trades con fecha_cierre)
  const tradesMap = {};
  tradesAll.filter(t => t.ticker_ars && t.fecha_cierre && t.fecha_apertura)
    .forEach(t => {
      const k = t.ticker_ars + '|' + t.fecha_apertura;
      tradesMap[k] = { qty: Number(t.cantidad), open: t.fecha_apertura, close: t.fecha_cierre };
    });

  // Helper: closest price before or on date
  const closestBefore = (pxMap, date) => {
    const prices = Object.keys(pxMap).filter(d => d <= date).sort();
    return prices.length ? pxMap[prices[prices.length-1]] : null;
  };

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const date of sortedDays) {
    const mep = mepByDate[date];
    if (!mep || mep <= 0) { skipped++; continue; }

    // Posiciones activas en esta fecha: abiertas y no cerradas
    const activePositions = posAll.filter(p => {
      if (!p.fecha_compra || p.fecha_compra > date) return false;
      return true; // portafolio positions have no close date
    });

    // Trades activos en esta fecha
    const activeTrades = tradesAll.filter(t => {
      if (!t.fecha_apertura || !t.ticker_ars) return false;
      if (t.fecha_apertura > date) return false;
      if (t.fecha_cierre && t.fecha_cierre <= date) return false;
      return true;
    });

    // Calcular valor_usd
    let totalUsd = 0;
    let hasPrice = false;

    for (const p of [...activePositions, ...activeTrades]) {
      const px = closestBefore(priceByTk[p.ticker_ars] || {}, date);
      if (!px || px <= 0) continue;
      const factor = BONOS.includes(p.tipo) ? 100 : 1;
      totalUsd += (Number(p.cantidad) * px) / (factor * mep);
      hasPrice = true;
    }

    if (!hasPrice || totalUsd <= 0) { skipped++; continue; }

    totalUsd = Math.round(totalUsd * 100) / 100;

    // PnL vs día anterior (o vs registro conocido más cercano)
    let pnlUsd = null;
    let pnlPct = null;

    if (prevValorUsd != null && prevValorUsd > 0) {
      const realized = realizedByDate[date] || 0;
      const intraday = intradayByDate[date] || 0;
      pnlUsd = Math.round((totalUsd - prevValorUsd + realized + intraday) * 100) / 100;
      pnlPct = Math.round(pnlUsd / prevValorUsd * 100 * 10000) / 10000;
    }

    // Insertar
    const body = JSON.stringify({
      user_email: 'elyagui@gmail.com',
      fecha: date,
      valor_usd: totalUsd,
      pnl_usd: pnlUsd,
      pnl_pct: pnlPct,
    });

    const res = await fetch(process.env.SB_URL + '/rest/v1/pnl_diario', {
      method: 'POST',
      headers: {
        apikey: process.env.SR_KEY,
        Authorization: 'Bearer ' + process.env.SR_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body,
    });

    if (res.ok || res.status === 204) {
      inserted++;
      console.log('  ✓ ' + date + ': valor=U\$S ' + totalUsd + ', pnl=' + (pnlUsd != null ? 'U\$S ' + pnlUsd : 'null'));
      // Actualizar prevValorUsd para el próximo día
      prevValorUsd = totalUsd;
    } else {
      const txt = await res.text().catch(() => 'unknown');
      console.error('  ✗ ' + date + ': HTTP ' + res.status + ' — ' + txt.substring(0, 100));
      errors++;
    }
  }

  console.log('');
  console.log('Resumen: ' + inserted + ' insertados, ' + skipped + ' omitidos, ' + errors + ' errores');
};

main().catch(e => { console.error(e); process.exit(1); });
" 2>&1 || log "WARN: error en backfill PnL"

log "✅ Backfill completado."

echo ""
echo "─────────────────────────────────────────"
echo "Para programar cada 5 minutos (solo PnL después de 17:00 ART):"
echo "  crontab -e"
echo "  */5 * * * * /mnt/c/dashboard/Github/scripts/monitor_dashboard.sh"
echo ""
echo "Para hacer backfill manual:"
echo "  ./scripts/backfill_calendario.sh [desde_fecha]"
echo "  Ej: ./scripts/backfill_calendario.sh 2026-01-01"
echo "─────────────────────────────────────────"
