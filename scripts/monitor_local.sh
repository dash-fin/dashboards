#!/usr/bin/env bash
# Cargar .env si existe
ENV_FILE="$(dirname "$0")/../.env.monitor"
[ -f "$ENV_FILE" ] && source "$ENV_FILE" 2>/dev/null || true
# ═══════════════════════════════════════════════════════════
# Monitor Local — Mercado Argentino (WSL)
# ═══════════════════════════════════════════════════════════
# Corre cada 5 min via crontab (lun-vie, 10:40-18:00 ART)
#
# Variables de entorno requeridas:
#   SUPABASE_SR_KEY  — service role key de Supabase
#   TG_TOKEN         — token del bot de Telegram
#
# Crontab:
#   SUPABASE_SR_KEY="..." TG_TOKEN="..." \
#   */5 * * * 1-5 /mnt/c/dashboard/Github/scripts/monitor_local.sh \
#     >> /mnt/c/dashboard/Github/scripts/monitor_local.log 2>&1
# ═══════════════════════════════════════════════════════════

set -euo pipefail

SB_URL="https://endymbpdayeidromxayb.supabase.co"
: "${SUPABASE_SR_KEY:?SUPABASE_SR_KEY no definida}"
SB_KEY="$SUPABASE_SR_KEY"
TG_CHAT_ID="${TG_CHAT_ID:-6209263987}"
LOG_FILE="/mnt/c/dashboard/Github/scripts/monitor_local.log"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Helpers ──
log() { echo "[$(TZ=America/Argentina/Buenos_Aires date '+%Y-%m-%d %H:%M:%S')] $*"; }
hour_art()  { TZ=America/Argentina/Buenos_Aires date +%H%M; }
date_art()  { TZ=America/Argentina/Buenos_Aires date +%Y-%m-%d; }
dow_art()   { TZ=America/Argentina/Buenos_Aires date +%u; }  # 1=lun..7=dom
in_range()  { local h; h=$(hour_art); [[ "$h" -ge "$1" && "$h" -le "$2" ]]; }
tg_send()   { curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" -d "chat_id=${TG_CHAT_ID}&text=${1}&parse_mode=HTML" -o /dev/null 2>/dev/null || true; }

# ⚠️ FIX: Supabase REST API parsing con --data-urlencode rompe queries con &.
# En vez de usar --data-urlencode, pasamos los params directamente en la URL.
sb_get() {
  local table="$1" params="$2"
  curl -s "${SB_URL}/rest/v1/${table}?${params}" \
    -H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" \
    -H "Accept: application/json" 2>/dev/null
}
sb_post() {
  local table="$1" data="$2"
  curl -s -X POST "${SB_URL}/rest/v1/${table}" \
    -H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" \
    -H "Content-Type: application/json" \
    -H "Prefer: resolution=merge-duplicates" \
    -d "${data}" 2>/dev/null
}
sb_post_no_merge() {
  local table="$1" data="$2"
  curl -s -X POST "${SB_URL}/rest/v1/${table}" \
    -H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" \
    -H "Content-Type: application/json" \
    -d "${data}" 2>/dev/null
}

# ── Watchdog ARS ──
watchdog_ars() {
  local max_age=420  # 7 min
  local now_epoch; now_epoch=$(date +%s)
  local fresh
  fresh=$(sb_get "mercado" "select=created_at&limit=1&order=created_at.desc" | grep -oP '"created_at":"\K[^"]+' | head -1)
  [[ -z "$fresh" ]] && { log "WATCHDOG: Sin datos en mercado"; return 1; }
  local fresh_epoch; fresh_epoch=$(date -d "$fresh" +%s 2>/dev/null || echo 0)
  if (( now_epoch - fresh_epoch > max_age )); then
    log "WATCHDOG: mercado sin actualizar desde $fresh ($((now_epoch - fresh_epoch))s)"
    return 1
  fi
  log "WATCHDOG: mercado OK ($((now_epoch - fresh_epoch))s)"
  return 0
}

# ── Dólar (MEP, CCL, oficial) ──
get_dolar() {
  local hoy; hoy=$(date_art)

  # Obtener AL30/AL30D desde edge function
  local resp
  resp=$(curl -s -X POST "${SB_URL}/functions/v1/yahoo-prices" \
    -H "Content-Type: application/json" -H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" \
    -d '{"mode":"rava-series","symbols":["AL30","AL30D","AL30C"]}' 2>/dev/null)

  local ars usd ccl al30 al30d al30c
  # AL30 (ARS)
  al30=$(echo "$resp" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for r in d.get('AL30',[]):
    if r.get('fecha') == '$hoy' and r.get('cierre',0) > 0: print(r['cierre']); break
" 2>/dev/null || echo "")
  # AL30D (USD)
  al30d=$(echo "$resp" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for r in d.get('AL30D',[]):
    if r.get('fecha') == '$hoy' and r.get('cierre',0) > 0: print(r['cierre']); break
" 2>/dev/null || echo "")
  # AL30C (CCL)
  al30c=$(echo "$resp" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for r in d.get('AL30C',[]):
    if r.get('fecha') == '$hoy' and r.get('cierre',0) > 0: print(r['cierre']); break
" 2>/dev/null || echo "")

  ars=${al30:-0}; usd=${al30d:-0}; ccl_ticker=${al30c:-0}

  # MEP
  local mep=""; ccl_val=""
  if [[ "$ars" != "0" && "$usd" != "0" ]]; then
    mep=$(echo "scale=2; $ars / $usd" | bc -l)
    log "DOLAR: MEP=$mep ($ars/$usd)"
    sb_post "mep_historico" "{\"fecha\":\"$hoy\",\"mep\":$mep,\"al30_ars\":$ars,\"al30d_usd\":$usd,\"fuente\":\"rava\"}"
    sb_post_no_merge "dolar_historico" "{\"fecha\":\"$hoy\",\"tipo\":\"mep\",\"close\":$mep,\"fuente\":\"rava\"}"
  fi

  # CCL
  if [[ "$ars" != "0" && "$ccl_ticker" != "0" ]]; then
    ccl_val=$(echo "scale=2; $ars / $ccl_ticker" | bc -l)
    log "DOLAR: CCL=$ccl_val ($ars/$ccl_ticker)"
    sb_post_no_merge "dolar_historico" "{\"fecha\":\"$hoy\",\"tipo\":\"ccl\",\"close\":$ccl_val,\"fuente\":\"rava\"}"
  fi

  # Oficial via ArgentinaDatos
  local of_resp oficial
  of_resp=$(curl -s "https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial" -H "User-Agent: Mozilla/5.0" 2>/dev/null)
  oficial=$(echo "$of_resp" | python3 -c "
import sys, json
d = json.load(sys.stdin)
r = [x for x in d if x.get('fecha') == '$hoy']
if r and r[-1].get('venta',0) > 0: print(r[-1]['venta'])
else: print(0)
" 2>/dev/null || echo "0")
  if [[ "$oficial" != "0" ]]; then
    log "DOLAR: Oficial=$oficial"
    sb_post_no_merge "dolar_historico" "{\"fecha\":\"$hoy\",\"tipo\":\"oficial\",\"close\":${oficial},\"fuente\":\"argentinadatos\"}"
  else
    # Fallback BCRA
    local bcra_id=4  # Tipo de cambio minorista
    local bcra_resp bcra_val
    bcra_resp=$(curl -s "https://api.bcra.gob.ar/estadisticas/v3.0/datosvariable/${bcra_id}/${hoy}/${hoy}" -H "Accept: application/json" 2>/dev/null)
    bcra_val=$(echo "$bcra_resp" | python3 -c "
import sys, json; d = json.load(sys.stdin); r = d.get('results',[]); print(r[-1].get('valor',0) if r else 0)
" 2>/dev/null || echo "0")
    if [[ "$bcra_val" != "0" ]]; then
      log "DOLAR: Oficial (BCRA)=$bcra_val"
      sb_post_no_merge "dolar_historico" "{\"fecha\":\"$hoy\",\"tipo\":\"oficial\",\"close\":$bcra_val,\"fuente\":\"bcra\"}"
    fi
  fi
}

# ── PnL Snapshot (portafolio + trades) ──
pnl_snapshot() {
  local hoy; hoy=$(date_art)
  log "PNL: Snapshot para $hoy"

  # MEP de hoy
  local mep_hoy
  mep_hoy=$(sb_get "mep_historico" "select=mep&fecha=eq.${hoy}&limit=1" | grep -oP '"mep":\K[\d.]+' | head -1)
  [[ -z "$mep_hoy" ]] && { log "PNL: Sin MEP para $hoy"; return 1; }
  log "PNL: MEP=$mep_hoy"

  # Obtener emails únicos de portafolio (activos)
  local emails
  emails=$(sb_get "portafolio" "select=user_email&activo=eq.true" | grep -oP '"user_email":"\K[^"]+' | sort -u)
  [[ -z "$emails" ]] && { log "PNL: Sin usuarios"; return 0; }

  local count=0
  for email in $emails; do
    # Skip si ya existe snapshot de hoy
    local chk
    chk=$(sb_get "pnl_diario" "user_email=eq.${email}&fecha=eq.${hoy}&select=fecha&limit=1")
    [[ -n "$chk" && "$chk" != "[]" ]] && { count=$((count+1)); continue; }

    log "PNL: Procesando $email"
    node -e "
const { createClient } = require('/mnt/c/dashboard/Github/node_modules/@supabase/supabase-js/dist/index.cjs');
const sb = createClient('${SB_URL}', '${SB_KEY}');
const BONOS = ['BONO_SOBERANO','DOLAR_LINKED','BONO_CER','BONO_DUAL'];
const email = '${email}';
const hoy = '${hoy}';
const mepHoy = ${mep_hoy};

(async () => {
  // 1. Posiciones activas (no opciones)
  const posAll = await sb.from('portafolio')
    .select('ticker_ars,tipo,cantidad,fecha_compra')
    .eq('user_email', email).eq('activo', true).neq('tipo', 'OPCION');
  if (!posAll.data || !posAll.data.length) process.exit(0);

  // 2. Trades CEDEAR multi-día cerrados hoy
  let realizedGain = 0;
  try {
    const td = await sb.from('trades')
      .select('ganancia_usd')
      .eq('user_email', email).eq('tipo', 'CEDEAR')
      .eq('fecha_cierre', hoy).lt('fecha_apertura', hoy);
    realizedGain = (td.data||[]).reduce((s,t) => s + Number(t.ganancia_usd||0), 0);
  } catch(e) {}

  // 3. Trades intradía (apertura=cierre=hoy)
  let intradayGain = 0;
  try {
    const ti = await sb.from('trades')
      .select('ganancia_usd')
      .eq('user_email', email).eq('tipo', 'CEDEAR')
      .eq('fecha_apertura', hoy).eq('fecha_cierre', hoy);
    intradayGain = (ti.data||[]).reduce((s,t) => s + Number(t.ganancia_usd||0), 0);
  } catch(e) {}

  // 4. Trades multi-día abiertos (close>hoy)
  let tradesAbiertos = [];
  try {
    const ta = await sb.from('trades')
      .select('ticker_ars,cantidad')
      .eq('user_email', email).eq('tipo', 'CEDEAR')
      .gt('fecha_cierre', hoy);
    tradesAbiertos = ta.data || [];
  } catch(e) {}

  // 5. Precios de mercado actuales
  const allTickers = [...new Set([
    ...posAll.data.map(p => p.ticker_ars),
    ...tradesAbiertos.map(t => t.ticker_ars)
  ])];
  const pxR = await sb.from('mercado')
    .select('symbol,last')
    .in('symbol', allTickers);
  const px = {};
  (pxR.data||[]).forEach(r => { if(r.last) px[r.symbol] = Number(r.last); });

  // 6. Calcular valor_usd total
  let totalUsd = 0;
  for (const p of posAll.data) {
    const precio = px[p.ticker_ars];
    if (!precio) continue;
    const factor = BONOS.includes(p.tipo) ? 100 : 1;
    totalUsd += (Number(p.cantidad) * precio) / (factor * mepHoy);
  }
  for (const t of tradesAbiertos) {
    const precio = px[t.ticker_ars];
    if (!precio) continue;
    totalUsd += (Number(t.cantidad) * precio) / mepHoy;
  }
  totalUsd = Math.round(totalUsd * 100) / 100;
  if (totalUsd <= 0) process.exit(0);

  // 7. PnL vs día hábil anterior
  const ayerR = await sb.from('pnl_diario')
    .select('valor_usd')
    .eq('user_email', email).lt('fecha', hoy)
    .order('fecha', { ascending: false }).limit(1);

  let pnlUsd = null;
  let pnlPct = null;
  if (ayerR.data && ayerR.data.length > 0) {
    const v0 = Number(ayerR.data[0].valor_usd);
    if (v0 > 0) {
      pnlUsd = Math.round((totalUsd - v0 + realizedGain + intradayGain) * 100) / 100;
      pnlPct = Math.round(pnlUsd / v0 * 100 * 10000) / 10000;
    }
  }

  // 8. Guardar
  const row = { user_email: email, fecha: hoy, valor_usd: totalUsd, pnl_usd: pnlUsd, pnl_pct: pnlPct };
  const res = await fetch('${SB_URL}/rest/v1/pnl_diario', {
    method:'POST',
    headers: { apikey: '${SB_KEY}', Authorization: 'Bearer ${SB_KEY}',
               'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row)
  });
  if (res.ok) {
    console.log(email + ': valor_usd=' + totalUsd + ', pnl_usd=' + (pnlUsd||'null'));
  } else {
    console.error(email + ': HTTP ' + res.status + ' ' + (await res.text()));
  }
})().catch(e => { console.error(email + ': ' + e.message); });
" 2>&1 | while IFS= read -r line; do log "PNL: $line"; done

    count=$((count+1))
  done
  log "PNL: $count usuarios procesados"
}

# ── Resumen Telegram ──
send_resumen() {
  local hoy; hoy=$(date_art)
  local mep ccl oficial
  mep=$(sb_get "mep_historico" "select=mep&fecha=eq.${hoy}&limit=1" | grep -oP '"mep":\K[\d.]+' | head -1)
  ccl=$(sb_get "dolar_historico" "select=close&fecha=eq.${hoy}&tipo=eq.ccl&limit=1" | grep -oP '"close":\K[\d.]+' | head -1)
  oficial=$(sb_get "dolar_historico" "select=close&fecha=eq.${hoy}&tipo=eq.oficial&limit=1" | grep -oP '"close":\K[\d.]+' | head -1)

  local msg="🏛️ <b>Resumen Diario — $hoy</b>%0A"
  msg+="MEP: <b>\$${mep:-N/A}</b>%0A"
  msg+="CCL: <b>\$${ccl:-N/A}</b>%0A"
  msg+="Oficial: <b>\$${oficial:-N/A}</b>"
  tg_send "$msg"
  log "RESUMEN: Enviado"
}

# ═══════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════

log "=== MONITOR LOCAL INICIO $(date_art) $(hour_art) ==="

_hora=$(hour_art)
_dia=$(dow_art)

# Fuera de horario o fin de semana
[[ "$_dia" -gt 5 ]] && { log "SKIP: finde"; exit 0; }
[[ "$_hora" -lt 1040 || "$_hora" -gt 1800 ]] && { log "SKIP: fuera de horario (${_hora})"; exit 0; }

# Watchdog (no bloqueante)
watchdog_ars || true

# Dólar + PnL al cierre (17:01-17:59)
if in_range 1701 1759; then
  get_dolar
  if in_range 1706 1759; then
    pnl_snapshot
  fi
  if in_range 1720 1730; then
    send_resumen
  fi
fi

log "=== MONITOR LOCAL FIN ==="
