#!/usr/bin/env bash
# Cargar .env si existe
ENV_FILE="$(dirname "$0")/../.env.monitor"
[ -f "$ENV_FILE" ] && source "$ENV_FILE" 2>/dev/null || true
# ═══════════════════════════════════════════════════════════
# Monitor USA — Mercado Norteamericano (WSL)
# ═══════════════════════════════════════════════════════════
# Corre cada 5 min via crontab (lun-vie, 08:10-20:30 ART)
#
# Funciones:
#   - Watchdog: verifica que tabla mercado_usa tenga precios frescos
#   - Health check: edge function yahoo-pipes responde?
#   - Earnings watch: consulta ADRs del portafolio, alerta próximos earnings
#
# Variables de entorno requeridas:
#   SUPABASE_SR_KEY  — service role key de Supabase
#   TG_TOKEN         — token del bot de Telegram
# ═══════════════════════════════════════════════════════════

set -euo pipefail

# ── Config ──
SB_URL="https://endymbpdayeidromxayb.supabase.co"
SB_KEY="${SUPABASE_SR_KEY:?SUPABASE_SR_KEY no definida}"
TG_CHAT_ID="${TG_CHAT_ID:-6209263987}"

SB_HEADERS=(-H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY")

# ── Helpers ──
log() { echo "[$(TZ=America/Argentina/Buenos_Aires date '+%Y-%m-%d %H:%M:%S')] $*"; }
hour_art() { TZ=America/Argentina/Buenos_Aires date +%H%M; }
tg_send() { curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" -d "chat_id=${TG_CHAT_ID}&text=${1}&parse_mode=HTML" -o /dev/null 2>/dev/null || true; }
sb_get()  { curl -s -G "${SB_URL}/rest/v1/$1" "${SB_HEADERS[@]}" --data-urlencode "$2" 2>/dev/null; }

# Flag file para evitar duplicados de earnings
EARNINGS_FLAG="/tmp/monitor_usa_earnings_sent.txt"

# ── Watchdog USA ──
watchdog_usa() {
  local max_age=420  # 7 minutos
  local now_epoch
  now_epoch=$(date +%s)
  local fresh
  fresh=$(sb_get "mercado_usa" "select=created_at&limit=1&order=created_at.desc" | grep -oP '"created_at":"\K[^"]+' | head -1)
  if [[ -z "$fresh" ]]; then
    log "WATCHDOG: No hay datos en mercado_usa"
    return 1
  fi
  local fresh_epoch
  fresh_epoch=$(date -d "$fresh" +%s 2>/dev/null || echo 0)
  if (( now_epoch - fresh_epoch > max_age )); then
    log "WATCHDOG: mercado_usa sin actualizar desde $fresh"
    return 1
  fi
  log "WATCHDOG: mercado_usa OK ($((now_epoch - fresh_epoch))s atrás)"
  return 0
}

# ── Health Check edge functions ──
health_check() {
  local resp
  resp=$(curl -s -o /dev/null -w "%{http_code}" -m 10 \
    "https://endymbpdayeidromxayb.supabase.co/functions/v1/yahoo-prices" \
    -H "Content-Type: application/json" \
    -d '{"action":"ping"}' 2>/dev/null || echo "000")
  if [[ "$resp" != "200" ]]; then
    log "HEALTH: yahoo-prices edge function caída (HTTP $resp)"
    tg_send "⚠️ <b>Alerta Infra</b>%0AEdge function yahoo-prices no responde (HTTP $resp)"
  else
    log "HEALTH: yahoo-prices OK"
  fi
}

# ── Earnings Watch ──
earnings_watch() {
  # Obtener ADRs del portafolio con próximos earnings
  local adrs
  adrs=$(sb_get "operaciones" "select=ticker&activo=eq.true&ticker_ars=like.*ADR*" 2>/dev/null | grep -oP '"ticker":"\K[^"]+' | sort -u)
  if [[ -z "$adrs" ]]; then
    # Fallback: buscar tickers de usa que estén en la watchlist
    adrs=$(sb_get "watchlist" "select=ticker" 2>/dev/null | grep -oP '"ticker":"\K[^"]+' | sort -u | head -20)
  fi
  if [[ -z "$adrs" ]]; then
    log "EARNINGS: No hay tickers para monitorear"
    return
  fi

  # Consultar earnings próximos a cada ticker
  local response
  response=$(curl -s -m 30 "https://endymbpdayeidromxayb.supabase.co/functions/v1/yahoo-prices" \
    -H "Content-Type: application/json" \
    -d "$(echo "{\"action\":\"earnings\",\"symbols\":[\"$(echo "$adrs" | tr '\n' ',' | sed 's/,$//' | sed 's/,/","/g')\"]}")" 2>/dev/null)

  if [[ -z "$response" ]]; then
    log "EARNINGS: Sin respuesta de yahoo-prices"
    return
  fi

  # Parsear earnings próximos (hasta 14 días)
  local hoy_epoch
  hoy_epoch=$(date +%s)
  local dos_semanas=$((hoy_epoch + 14 * 86400))
  local alerts=""

  for ticker in $adrs; do
    local earnings_json
    earnings_json=$(echo "$response" | grep -oP "\"${ticker}\":\{[^}]+\}" | head -1)
    if [[ -z "$earnings_json" ]]; then continue; fi
    local earnings_date
    earnings_date=$(echo "$earnings_json" | grep -oP '"earningsDate":\[\[?\K[0-9]+' | head -1)
    if [[ -z "$earnings_date" ]]; then continue; fi
    # Convertir timestamp (yahoo devuelve ms)
    local earnings_epoch=$((earnings_date / 1000))
    if (( earnings_epoch > hoy_epoch && earnings_epoch < dos_semanas )); then
      local earnings_str
      earnings_str=$(TZ=America/Argentina/Buenos_Aires date -d "@$earnings_epoch" '+%Y-%m-%d' 2>/dev/null)
      # Check flag para no repetir
      if ! grep -q "${ticker}|${earnings_str}" "$EARNINGS_FLAG" 2>/dev/null; then
        alerts+="📅 ${ticker}: earnings ${earnings_str}%0A"
        echo "${ticker}|${earnings_str}" >> "$EARNINGS_FLAG"
        log "EARNINGS: ${ticker} → ${earnings_str}"
      fi
    fi
  done

  if [[ -n "$alerts" ]]; then
    tg_send "📊 <b>Earnings Próximos</b>%0A${alerts}"
    log "EARNINGS: Alertas enviadas a Telegram"
  else
    log "EARNINGS: Sin earnings próximos"
  fi
}


# ═══════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════

log "=== MONITOR USA INICIO ==="

# Horario USA (lun-vie, 08:10-20:30 ART)
hora=$(hour_art)
dia=$(date +%u)
if [[ "$dia" -gt 5 || "$hora" -lt 0810 || "$hora" -gt 2030 ]]; then
  log "SKIP: Fuera de horario USA (hora=$hora, dia=$dia)"
  exit 0
fi

# Watchdog
watchdog_usa || log "WATCHDOG: Alerta — mercado_usa no actualizado"

# Health check edge functions (cada hora)
if (( hora % 100 <= 15 )); then
  health_check
fi

# Earnings watch (solo a las 09:30, 12:00, 16:00 ART)
if [[ "$hora" == "093"* || "$hora" == "120"* || "$hora" == "160"* ]]; then
  earnings_watch
fi

log "=== MONITOR USA FIN ==="
