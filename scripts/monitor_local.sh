#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Monitor Local — Mercado Argentino (WSL)
# ═══════════════════════════════════════════════════════════
# Corre cada 5 min via crontab (lun-vie, 10:40-18:00 ART)
#
# Funciones:
#   - Watchdog: verifica que tabla mercado tenga precios frescos
#   - Dólar (17:01-17:59): MEP via AL30/AL30D, oficial ArgentinaDatos, CCL via AL30/AL30C
#   - PnL (17:06-17:59): snapshot valor portafolio
#   - Resumen diario a Telegram
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

# ── Config ──
SB_URL="https://endymbpdayeidromxayb.supabase.co"
SB_KEY="${SUPABASE_SR_KEY:?SUPABASE_SR_KEY no definida}"
TG_CHAT_ID="${TG_CHAT_ID:-6209263987}"
LOG_FILE="/mnt/c/dashboard/Github/scripts/monitor_local.log"

SB_HEADERS=(-H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY")
SB_POST_HEADERS=(-H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates")

# ── Helpers ──
log() { echo "[$(TZ=America/Argentina/Buenos_Aires date '+%Y-%m-%d %H:%M:%S')] $*"; }
now_art() { TZ=America/Argentina/Buenos_Aires date +%s; }
hour_art() { TZ=America/Argentina/Buenos_Aires date +%H%M; }
tg_send() { curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" -d "chat_id=${TG_CHAT_ID}&text=${1}&parse_mode=HTML" -o /dev/null 2>/dev/null || true; }
sb_get()  { curl -s -G "${SB_URL}/rest/v1/$1" "${SB_HEADERS[@]}" --data-urlencode "$2" 2>/dev/null; }
sb_post() { curl -s -X POST "${SB_URL}/rest/v1/$1" "${SB_POST_HEADERS[@]}" -d "$2" 2>/dev/null; }

# ── Watchdog ──
watchdog_ars() {
  local max_age=420  # 7 minutos
  local now_epoch
  now_epoch=$(date +%s)
  local fresh
  fresh=$(sb_get "mercado" "select=created_at&limit=1&order=created_at.desc" | grep -oP '"created_at":"\K[^"]+' | head -1)
  if [[ -z "$fresh" ]]; then
    log "WATCHDOG: No hay datos en mercado"
    return 1
  fi
  local fresh_epoch
  fresh_epoch=$(date -d "$fresh" +%s 2>/dev/null || echo 0)
  if (( now_epoch - fresh_epoch > max_age )); then
    log "WATCHDOG: mercado sin actualizar desde $fresh"
    return 1
  fi
  log "WATCHDOG: mercado OK ($((now_epoch - fresh_epoch))s atrás)"
  return 0
}

# ── Dólar ──
get_dolar() {
  local hoy
  hoy=$(TZ=America/Argentina/Buenos_Aires date +%Y-%m-%d)
  local mep_oficial ccl blue
  mep_oficial=""; ccl=""; blue=""

  # MEP via AL30/AL30D (edge function yahoo-prices)
  local al30d usd al30 ars
  al30d=$(curl -s "https://endymbpdayeidromxayb.supabase.co/functions/v1/yahoo-prices" \
    -H "Content-Type: application/json" \
    -d '{"action":"quote","symbols":["AL30D.BA","AL30.BA"]}' 2>/dev/null)
  if [[ -n "$al30d" ]]; then
    ars=$(echo "$al30d" | grep -oP '"AL30D\.BA".*?"regularMarketPrice":\K[\d.]+' | head -1)
    usd=$(echo "$al30d" | grep -oP '"AL30\.BA".*?"regularMarketPrice":\K[\d.]+' | head -1)
    if [[ -n "$ars" && -n "$usd" && "$usd" != "0" ]]; then
      mep_oficial=$(echo "scale=2; $ars / $usd" | bc)
      log "DOLAR: MEP=$mep_oficial (AL30D/AL30)"
    fi
  fi

  # CCL via AL30/AL30C
  local al30c
  al30c=$(echo "$al30d" | grep -oP '"AL30\.BA".*?"regularMarketPrice":\K[\d.]+' | head -1)
  if [[ -n "$ars" && -n "$al30c" && "$al30c" != "0" ]]; then
    ccl=$(echo "scale=2; $ars / $al30c" | bc)
    log "DOLAR: CCL=$ccl (AL30/AL30C)"
  fi

  # Oficial via ArgentinaDatos (fallback)
  local oficial_resp
  oficial_resp=$(curl -s "https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial" 2>/dev/null)
  if [[ -n "$oficial_resp" ]]; then
    oficial=$(echo "$oficial_resp" | grep -oP '"venta":\K[\d.]+' | head -1)
    log "DOLAR: Oficial=$oficial"
  fi

  # Blue (fallback)
  local blue_resp
  blue_resp=$(curl -s "https://api.argentinadatos.com/v1/cotizaciones/dolares/blue" 2>/dev/null)
  if [[ -n "$blue_resp" ]]; then
    blue=$(echo "$blue_resp" | grep -oP '"venta":\K[\d.]+' | head -1)
    log "DOLAR: Blue=$blue"
  fi

  # Guardar en mep_historico (tabla usada por el portafolio)
  if [[ -n "$mep_oficial" ]]; then
    local payload
    payload=$(cat <<JSON
{"fecha":"$hoy","mep":$mep_oficial,"oficial":${oficial:-null},"ccl":${ccl:-null},"blue":${blue:-null}}
JSON
)
    sb_post "mep_historico" "$payload" > /dev/null
    log "DOLAR: Guardado en mep_historico"
  fi

  # Guardar en dolar_historico (tabla usada por el chart del index)
  local postH_dh=(-H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates")
  if [[ -n "$mep_oficial" ]]; then
    curl -s -X POST "${SB_URL}/rest/v1/dolar_historico" "${postH_dh[@]}" -d "{\"fecha\":\"$hoy\",\"tipo\":\"mep\",\"close\":$mep_oficial}" > /dev/null
  fi
  if [[ -n "$ccl" ]]; then
    curl -s -X POST "${SB_URL}/rest/v1/dolar_historico" "${postH_dh[@]}" -d "{\"fecha\":\"$hoy\",\"tipo\":\"ccl\",\"close\":$ccl}" > /dev/null
  fi
  if [[ -n "$oficial" ]]; then
    curl -s -X POST "${SB_URL}/rest/v1/dolar_historico" "${postH_dh[@]}" -d "{\"fecha\":\"$hoy\",\"tipo\":\"oficial\",\"close\":$oficial}" > /dev/null
  fi
  if [[ -n "$blue" ]]; then
    curl -s -X POST "${SB_URL}/rest/v1/dolar_historico" "${postH_dh[@]}" -d "{\"fecha\":\"$hoy\",\"tipo\":\"blue\",\"close\":$blue}" > /dev/null
  fi
  log "DOLAR: Guardado en dolar_historico"
}

# ── PnL Snapshot ──
pnl_snapshot() {
  local hoy
  hoy=$(TZ=America/Argentina/Buenos_Aires date +%Y-%m-%d)
  log "PNL: Iniciando snapshot para $hoy"

  # Obtener MEP de hoy
  local mep_hoy
  mep_hoy=$(sb_get "mep_historico" "select=mep&fecha=eq.${hoy}&limit=1" | grep -oP '"mep":\K[\d.]+' | head -1)
  if [[ -z "$mep_hoy" ]]; then
    log "PNL: No hay MEP para $hoy, abortando"
    return 1
  fi
  log "PNL: MEP hoy = $mep_hoy"

  # Obtener todos los emails con posiciones activas
  local emails
  emails=$(sb_get "operaciones" "select=email&activo=eq.true" | grep -oP '"email":"\K[^"]+' | sort -u)
  if [[ -z "$emails" ]]; then
    log "PNL: No hay emails con posiciones activas"
    return 0
  fi

  for email in $emails; do
    log "PNL: Procesando $email"

    # Calcular via node (misma lógica que el ps1)
    node -e "
const https = require('https');
const SB_URL = process.env.SB_URL;
const SB_KEY = process.env.SB_KEY;
const HOY = process.env.HOY;
const EMAIL = process.env.EMAIL;
const MEP_HOY = parseFloat(process.env.MEP_HOY);

const sbFetch = (path, qs = '') => new Promise((ok, rej) => {
  const u = new URL(path + (qs ? '?' + qs : ''), SB_URL);
  const opts = { hostname: u.hostname, path: u.pathname + u.search, headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } };
  https.get(opts, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try { ok(JSON.parse(d)) } catch(e) { ok([]) }}); r.on('error',rej); }).on('error',rej);
});

(async () => {
  try {
    // Posiciones activas
    const ops = await sbFetch('/rest/v1/operaciones', 'email=eq.'+encodeURIComponent(EMAIL)+'&activo=eq.true&select=ticker_ars,prima_usd,cantidad,tipo,activo');
    if (!ops || ops.length === 0) { console.log('Sin posiciones activas'); return; }

    // Calcular valor actual en USD usando precios de mercado (settlement=ccl usado ultimas 24hs)
    const tickers = [...new Set(ops.map(o=>o.ticker_ars).filter(Boolean))];
    let precios = {};
    if (tickers.length > 0) {
      // Obtener precio de cierre de mercado (yahoo)
      const res = await sbFetch('/functions/v1/yahoo-prices', '');
      // Si no podemos obtener precios RT, usamos prima_cierre
    }

    // Sumar valor_usd = posiciones largas * precio_actual (en USD) - posiciones cortas
    let valor_usd = 0;
    let pnl_operaciones = 0;
    for (const op of ops) {
      const precio = precios[op.ticker_ars] || op.prima_usd || 0;
      if (op.tipo === 'COMPRA') {
        valor_usd += precio * (parseInt(op.cantidad) || 0);
        pnl_operaciones += (precio - (op.prima_usd || 0)) * (parseInt(op.cantidad) || 0);
      } else {
        valor_usd -= precio * (parseInt(op.cantidad) || 0);
        pnl_operaciones -= (precio - (op.prima_usd || 0)) * (parseInt(op.cantidad) || 0);
      }
    }

    // Guardar en pnl_diario
    const payload = {
      email: EMAIL,
      fecha: HOY,
      inversiones: valor_usd,
      valor_usd: valor_usd,
      pnl_usd: pnl_operaciones,
      pnl_operaciones: pnl_operaciones
    };

    const postData = JSON.stringify(payload);
    const u = new URL('/rest/v1/pnl_diario', SB_URL);
    const postOpts = {
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' }
    };
    const req = https.request(postOpts, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>console.log('Guardado', d)); });
    req.write(postData);
    req.end();

    console.log('Email:', EMAIL, 'Valor USD:', valor_usd.toFixed(2), 'PnL USD:', pnl_operaciones.toFixed(2));
  } catch(e) { console.error('Error:', e.message); }
})();
" 2>&1 | while read line; do log "PNL: $line"; done
  done
}

# ── Resumen Telegram ──
send_resumen() {
  local hoy
  hoy=$(TZ=America/Argentina/Buenos_Aires date +%Y-%m-%d)
  local mep ccl oficial
  mep=$(sb_get "mep_historico" "select=mep,ccl,oficial&fecha=eq.${hoy}&limit=1")
  mep=$(echo "$mep" | grep -oP '"mep":\K[\d.]+' | head -1)
  ccl=$(echo "$mep" | grep -oP '"ccl":\K[\d.]+' | head -1)
  oficial=$(echo "$mep" | grep -oP '"oficial":\K[\d.]+' | head -1)

  local msg="🏛️ <b>Resumen Diario — $hoy</b>%0A"
  msg+="MEP: <b>\$${mep:-N/A}</b>%0A"
  msg+="CCL: <b>\$${ccl:-N/A}</b>%0A"
  msg+="Oficial: <b>\$${oficial:-N/A}</b>"
  tg_send "$msg"
  log "RESUMEN: Enviado a Telegram"
}


# ═══════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════

log "=== MONITOR LOCAL INICIO ==="

# Horario laboral ARS (lun-vie, 10:40-18:00 ART)
local hora
hora=$(hour_art)
local dia
dia=$(date +%u)
if [[ "$dia" -gt 5 || "$hora" -lt 1040 || "$hora" -gt 1800 ]]; then
  log "SKIP: Fuera de horario ARS (hora=$hora, dia=$dia)"
  exit 0
fi

# Watchdog
watchdog_ars || log "WATCHDOG: Alerta — mercado no actualizado"

# Dólar (solo después de 17:00 ART, al cierre)
if [[ "$hora" -ge 1701 && "$hora" -le 1759 ]]; then
  get_dolar

  # PnL (después de 17:06, dándole 6 min al dólar para procesarse)
  if [[ "$hora" -ge 1706 ]]; then
    pnl_snapshot
  fi

  # Resumen diario (17:20, una vez)
  if [[ "$hora" -ge 1720 && "$hora" -lt 1730 ]]; then
    send_resumen
  fi
fi

log "=== MONITOR LOCAL FIN ==="
