#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Backfill Calendario PnL
# Rellena días faltantes en pnl_diario para emaily ${EMAIL} con MEP disponible
# ═══════════════════════════════════════════════════════════
# Uso: ./backfill_calendario.sh [desde_fecha]
# Ej:  ./backfill_calendario.sh 2026-05-01
#
# Variables de entorno: SUPABASE_SR_KEY
# ═══════════════════════════════════════════════════════════

set -euo pipefail

SB_URL="https://endymbpdayeidromxayb.supabase.co"
SB_KEY="${SUPABASE_SR_KEY:?SUPABASE_SR_KEY no definida}"
SB_HEADERS=(-H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY")
SB_POST_HEADERS=(-H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates")

log() { echo "[$(TZ=America/Argentina/Buenos_Aires date '+%Y-%m-%d %H:%M:%S')] $*"; }
sb_get() { curl -s -G "${SB_URL}/rest/v1/$1" "${SB_HEADERS[@]}" --data-urlencode "$2" 2>/dev/null; }
sb_post() { curl -s -X POST "${SB_URL}/rest/v1/$1" "${SB_POST_HEADERS[@]}" -d "$2" 2>/dev/null; }

# Fecha desde
DESDE="${1:-2026-01-01}"
LOG_FILE="/tmp/backfill_calendario.log"
export SB_URL SB_KEY

log "Backfill desde $DESDE"

# Obtener fechas con MEP disponible que NO tienen pnl_diario
FECHAS=$(sb_get "mep_historico" "select=fecha&fecha=gte.${DESDE}&order=fecha.asc" | \
  grep -oP '"fecha":"\K[^"]+' | sort -u)

for FECHA in $FECHAS; do
  # Ver si ya existe pnl_diario para esta fecha
  EXISTE=$(sb_get "pnl_diario" "select=fecha&fecha=eq.${FECHA}&limit=1")
  if [[ -n "$EXISTE" && "$EXISTE" != "[]" ]]; then
    log "SKIP $FECHA: ya tiene pnl_diario"
    continue
  fi

  # Obtener MEP de esa fecha
  MEP=$(sb_get "mep_historico" "select=mep&fecha=eq.${FECHA}" | grep -oP '"mep":\K[\d.]+' | head -1)
  if [[ -z "$MEP" ]]; then
    log "SKIP $FECHA: sin MEP"
    continue
  fi

  log "PROCESANDO $FECHA (MEP=$MEP)"

  # Obtener posiciones activas en esa fecha
  node -e "
const https = require('https');
const SB_URL = process.env.SB_URL;
const SB_KEY = process.env.SB_KEY;
const HOY = process.env.FECHA;
const MEP_HOY = parseFloat(process.env.MEP);

const sbFetch = (path, qs) => new Promise((ok, rej) => {
  const u = new URL(path + (qs ? '?' + qs : ''), SB_URL);
  const opts = { hostname: u.hostname, path: u.pathname + u.search, headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } };
  https.get(opts, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try { ok(JSON.parse(d)) } catch(e) { ok([]) }}); r.on('error',rej); }).on('error',rej);
});

(async () => {
  try {
    const ops = await sbFetch('/rest/v1/operaciones', 'activo=eq.true&select=email,ticker_ars,prima_usd,cantidad,tipo');
    const emails = [...new Set(ops.filter(o=>o.email).map(o=>o.email))];
    if (emails.length === 0) { console.log('Sin emails'); return; }

    for (const email of emails) {
      const userOps = ops.filter(o => o.email === email);
      let valor_usd = 0;
      for (const op of userOps) {
        const precio = op.prima_usd || 0;
        if (op.tipo === 'COMPRA') valor_usd += precio * (parseInt(op.cantidad) || 0);
        else valor_usd -= precio * (parseInt(op.cantidad) || 0);
      }

      const payload = { email, fecha: HOY, inversiones: valor_usd, valor_usd };
      const postData = JSON.stringify(payload);
      const u = new URL('/rest/v1/pnl_diario', SB_URL);
      const postOpts = {
        hostname: u.hostname, path: u.pathname, method: 'POST',
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' }
      };
      const req = https.request(postOpts, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>console.log(email, 'OK')); });
      req.write(postData);
      req.end();
    }
  } catch(e) { console.error('Error:', e.message); }
})();
" 2>&1 | while read line; do log "  $FECHA: $line"; done
done

log "Backfill completado"
