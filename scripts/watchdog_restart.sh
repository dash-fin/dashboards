#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# watchdog_restart.sh — Reinicia tasks Windows si están stale
#
# Único trabajo: detectar staleness y matar+reiniciar la task.
# Las alertas (Telegram) y dolar/PnL/etc viven en Supabase monitor-cron.
#
# Necesita la PC prendida (la task original también).
# ════════════════════════════════════════════════════════════════

ENV_FILE="$(dirname "$0")/../.env.monitor"
[ -f "$ENV_FILE" ] && source "$ENV_FILE" 2>/dev/null || true

SB_URL="https://endymbpdayeidromxayb.supabase.co"
: "${SUPABASE_SR_KEY:?SUPABASE_SR_KEY no definida}"
SB_KEY="$SUPABASE_SR_KEY"
LOG_FILE="$(dirname "$0")/watchdog_restart.log"
STALE_THRESHOLD=480   # 8 minutos

log() { echo "[$(TZ=America/Argentina/Buenos_Aires date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }
hour_art() { TZ=America/Argentina/Buenos_Aires date +%H%M; }
dow_art() { TZ=America/Argentina/Buenos_Aires date +%u; }

# Fuera de horario o finde
_dia=$(dow_art); _hora=$(hour_art)
[[ "$_dia" -gt 5 ]] && exit 0
[[ "$_hora" -lt 810 || "$_hora" -gt 2030 ]] && exit 0

# Devuelve la edad (segundos) del último registro
age_seconds() {
  local table="$1" col="$2"
  local last
  last=$(curl -s "${SB_URL}/rest/v1/${table}?select=${col}&order=${col}.desc&limit=1" \
    -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
    | grep -oP "\"${col}\":\"\K[^\"]+" | head -1)
  [[ -z "$last" ]] && { echo 99999; return; }
  local last_epoch now_epoch
  last_epoch=$(date -d "$last" +%s 2>/dev/null || echo 0)
  now_epoch=$(date +%s)
  echo $((now_epoch - last_epoch))
}

# Mata Python huérfanos asociados a un script + reinicia task
kill_and_restart() {
  local task_name="$1" python_pattern="$2"
  log "RESTART: matando python de '$python_pattern' y reiniciando '$task_name'"
  # Mata procesos Python que ejecutan el script específico
  cmd.exe /c "wmic process where \"name='python.exe' and commandline like '%${python_pattern}%'\" delete" 2>/dev/null | head -2 >> "$LOG_FILE"
  sleep 2
  # End task primero (para evitar instancias duplicadas) y luego run
  cmd.exe /c "schtasks /end /tn \"\\${task_name}\"" 2>/dev/null
  sleep 1
  cmd.exe /c "schtasks /run /tn \"\\${task_name}\"" 2>/dev/null
  log "RESTART: '$task_name' lanzada"
}

# ── ARS ──
if [[ "$_hora" -ge 1040 && "$_hora" -le 1800 ]]; then
  age=$(age_seconds "mercado" "updated_at")
  if (( age > STALE_THRESHOLD )); then
    log "ARS stale ${age}s — restart"
    kill_and_restart "Dashboard" "monitor_rt.py"
  fi
fi

# ── USA ──
if [[ "$_hora" -ge 810 && "$_hora" -le 2030 ]]; then
  age=$(age_seconds "mercado_usa" "updated_at")
  if (( age > STALE_THRESHOLD )); then
    log "USA stale ${age}s — restart"
    kill_and_restart "Dashboard USA" "alpaca_usa.py"
  fi
fi
