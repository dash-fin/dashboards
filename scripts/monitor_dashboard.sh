#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Monitor Dashboard — versión WSL (bash)
# Alternativa al monitor_dashboard.ps1 que corre en Windows
# Task Scheduler.
#
# Funciones:
#   - Watchdog de monitores de mercado (ARS + USA)
#   - Snapshot diario de dólar (MEP, oficial, CCL) al cierre
#   - Snapshot diario P&L del portafolio (17:06–17:59 ART)
#   - Alerta de earnings próximos
#
# Configuración:
#   Cada 5 minutos via crontab:
#     */5 * * * * /mnt/c/dashboard/Github/scripts/monitor_dashboard.sh
# ═══════════════════════════════════════════════════════════

set -euo pipefail

# ── Config ────────────────────────────────────────────────
TG_TOKEN="8576934070:AAFrb--ocLPcFZh-mOzFDTc5ujYnouA3H3U"
TG_CHAT_ID="6209263987"
SB_URL="https://endymbpdayeidromxayb.supabase.co"
SB_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVuZHltYnBkYXllaWRyb214YXliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MzU4NTAsImV4cCI6MjA4OTExMTg1MH0.BCZRvE9F1g_w2ffwj6NA6vyCYab2XcHDgmZir3CkeOk"

# Flags directory — usar /tmp porque WSL no tiene flag files persistentes
FLAGS_DIR="/tmp/monitor_dashboard"
mkdir -p "$FLAGS_DIR"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$SCRIPT_DIR/monitor_dashboard.log"

# ── Timezone helper (GMT-3 Argentina) ─────────────────────
# WSL usa UTC por defecto. TZ=America/Argentina/Buenos_Aires para hora ARG.
ARG_TZ="America/Argentina/Buenos_Aires"

arg_date() {
  # Devuelve fecha en formato yyyy-MM-dd
  TZ="$ARG_TZ" date +%Y-%m-%d
}

arg_time() {
  # Devuelve hora HH:MM:SS
  TZ="$ARG_TZ" date +%H:%M:%S
}

arg_hour_min() {
  # Devuelve HH:MM (sin segundos) para comparaciones
  TZ="$ARG_TZ" date +%H:%M
}

arg_now_epoch() {
  TZ="$ARG_TZ" date +%s
}

arg_dow() {
  TZ="$ARG_TZ" date +%u  # 1=lunes .. 7=domingo
}

# ── Logging ───────────────────────────────────────────────
log() {
  local ts
  ts=$(TZ="$ARG_TZ" date "+%Y-%m-%d %H:%M:%S")
  echo "$ts $*" >> "$LOG_FILE"
  echo "$ts $*"
}

# ── Telegram ──────────────────────────────────────────────
send_tg() {
  local msg="$1"
  curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"chat_id":%s,"text":"%s","parse_mode":"Markdown"}' "$TG_CHAT_ID" "$msg")" \
    > /dev/null 2>&1 || true
}

# ── Supabase helpers ──────────────────────────────────────
SB_HEADERS=(-H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY")
SB_POST_HEADERS=(-H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: resolution=merge-duplicates,return=minimal")

sb_get() {
  local table="$1" params="$2"
  curl -s -G "${SB_URL}/rest/v1/${table}" \
    "${SB_HEADERS[@]}" \
    --data-urlencode "$params" \
    -H "Accept: application/json" 2>/dev/null
}

sb_post() {
  local table="$1" data="$2"
  curl -s -X POST "${SB_URL}/rest/v1/${table}" \
    "${SB_POST_HEADERS[@]}" \
    -d "$data" 2>/dev/null
}

# ── Staleness check ───────────────────────────────────────
stale_seconds() {
  local table="$1"
  local resp
  resp=$(sb_get "$table" "select=updated_at&order=updated_at.desc.nullslast&limit=1")
  if [ -z "$resp" ] || [ "$resp" = "[]" ]; then
    echo 9999
    return
  fi
  local upd_at
  upd_at=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0].get('updated_at','') if d else '')" 2>/dev/null || echo "")
  if [ -z "$upd_at" ]; then
    echo 9999
    return
  fi
  local upd_epoch
  upd_epoch=$(date -d "$upd_at" +%s 2>/dev/null || echo 0)
  local now_epoch
  now_epoch=$(date +%s)
  echo $(( now_epoch - upd_epoch ))
}

# ── Time range check (hora ARG) ───────────────────────────
# Devuelve 0 (true) si la hora actual está en [start, end)
in_time_range() {
  local start="$1" end="$2"
  local now
  now=$(arg_hour_min)
  if [[ "$now" > "$start" || "$now" == "$start" ]]; then
    if [[ "$now" < "$end" ]]; then
      return 0
    fi
  fi
  return 1
}

# ── Watchdog wrapper ──────────────────────────────────────
watch_monitor() {
  local task_path="$1" label="$2" table="$3" flag_file="$4" start_time="$5" end_time="$6"

  local dow
  dow=$(arg_dow)
  # Fines de semana: limpiar flag y salir
  if [ "$dow" -ge 6 ]; then
    rm -f "$flag_file"
    return
  fi

  # Fuera de horario
  if ! in_time_range "$start_time" "$end_time"; then
    rm -f "$flag_file"
    return
  fi

  local stale
  stale=$(stale_seconds "$table")
  local STALE_LIMIT=$((7 * 60))

  if [ "$stale" -le "$STALE_LIMIT" ]; then
    # Datos frescos: si había flag, avisar recuperación
    if [ -f "$flag_file" ]; then
      rm -f "$flag_file"
      send_tg "[Watchdog] *${label} recuperado*\\nDatos actualizados correctamente."
    fi
    return
  fi

  # Datos viejos: actuar solo si no se notificó antes
  if [ ! -f "$flag_file" ]; then
    touch "$flag_file"
    send_tg "[Watchdog] *${label} reiniciado*\\nDatos sin actualizar hace $((stale / 60))m. Reiniciando..."
  fi
}

# ═══════════════════════════════════════════════════════════
# INICIO DEL CICLO
# ═══════════════════════════════════════════════════════════

log "=== monitor_dashboard.sh inicio ==="

# ── Watchdog monitores de mercado ─────────────────────────
watch_monitor "\Dashboard"     "Monitor ARS" "mercado"     "$FLAGS_DIR/wd_ars.flag" "10:40" "16:59"
watch_monitor "\Dashboard USA" "Monitor USA" "mercado_usa" "$FLAGS_DIR/wd_usa.flag" "08:10" "20:30"

# ── Captura diaria al cierre (17:01–17:59 ARG) ───────────
HOY=$(arg_date)
DOW=$(arg_dow)

if in_time_range "17:01" "17:59" && [ "$DOW" -le 5 ]; then
  log "INFO dólar: iniciando snapshot diario para $HOY"

  # ── MEP: AL30/AL30D desde Rava (edge function) ──
  MEP_EXISTS=$(sb_get "mep_historico" "fecha=eq.${HOY}&select=fecha&limit=1")
  if [ -z "$MEP_EXISTS" ] || [ "$MEP_EXISTS" = "[]" ]; then
    log "INFO dólar: calculando MEP desde Rava..."
    EDGE_RESP=$(curl -s -X POST "${SB_URL}/functions/v1/yahoo-prices" \
      -H "Content-Type: application/json" \
      -H "apikey: $SB_KEY" \
      -H "Authorization: Bearer $SB_KEY" \
      -d '{"mode":"rava-series","symbols":["AL30","AL30D"]}' 2>/dev/null)

    if [ -n "$EDGE_RESP" ]; then
      AL30_PX=$(echo "$EDGE_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
al30 = data.get('AL30', [])
for r in al30:
    if r.get('fecha') == '$HOY' and r.get('cierre', 0) > 0:
        print(r['cierre'])
        break
" 2>/dev/null || echo "0")

      AL30D_PX=$(echo "$EDGE_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
al30d = data.get('AL30D', [])
for r in al30d:
    if r.get('fecha') == '$HOY' and r.get('cierre', 0) > 0:
        print(r['cierre'])
        break
" 2>/dev/null || echo "0")

      if [ "$(echo "$AL30_PX > 0" | bc -l 2>/dev/null)" = "1" ] && \
         [ "$(echo "$AL30D_PX > 0" | bc -l 2>/dev/null)" = "1" ]; then
        MEP=$(echo "scale=2; $AL30_PX / $AL30D_PX" | bc -l 2>/dev/null || echo "0")
        if [ "$(echo "$MEP > 0" | bc -l 2>/dev/null)" = "1" ]; then
          sb_post "mep_historico" "{\"fecha\":\"$HOY\",\"mep\":$MEP,\"al30_ars\":$AL30_PX,\"al30d_usd\":$AL30D_PX,\"fuente\":\"rava\"}"
          sb_post "dolar_historico" "{\"fecha\":\"$HOY\",\"tipo\":\"mep\",\"close\":$MEP,\"fuente\":\"rava\"}"
          log "INFO dólar: MEP = $MEP"
        fi
      fi
    fi
  fi

  # ── Dólar oficial: ArgentinaDatos API ──
  OF_EXISTS=$(sb_get "dolar_historico" "fecha=eq.${HOY}&tipo=eq.oficial&select=fecha&limit=1")
  if [ -z "$OF_EXISTS" ] || [ "$OF_EXISTS" = "[]" ]; then
    log "INFO dólar: buscando oficial..."
    OF_RESP=$(curl -s "https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial" \
      -H "User-Agent: Mozilla/5.0" 2>/dev/null)
    OF_CLOSE=$(echo "$OF_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
last = [r for r in data if r.get('fecha') == '$HOY']
if last and last[-1].get('venta', 0) > 0:
    print(last[-1]['venta'])
else:
    print(0)
" 2>/dev/null || echo "0")

    if [ "$(echo "$OF_CLOSE > 0" | bc -l 2>/dev/null)" = "1" ]; then
      sb_post "dolar_historico" "{\"fecha\":\"$HOY\",\"tipo\":\"oficial\",\"close\":$OF_CLOSE,\"fuente\":\"argentinadatos\"}"
      log "INFO dólar: oficial = $OF_CLOSE"
    else
      # Fallback BCRA
      log "INFO dólar: fallback BCRA..."
      BCR_RESP=$(curl -s "https://api.bcra.gob.ar/estadisticas/v3.0/datosvariable/4/${HOY}/${HOY}" \
        -H "Accept: application/json" 2>/dev/null)
      BCR_VAL=$(echo "$BCR_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
results = data.get('results', [])
if results:
    print(results[-1].get('valor', 0))
else:
    print(0)
" 2>/dev/null || echo "0")
      if [ "$(echo "$BCR_VAL > 0" | bc -l 2>/dev/null)" = "1" ]; then
        sb_post "dolar_historico" "{\"fecha\":\"$HOY\",\"tipo\":\"oficial\",\"close\":$BCR_VAL,\"fuente\":\"bcra\"}"
        log "INFO dólar: oficial (BCRA) = $BCR_VAL"
      fi
    fi
  fi

  # ── CCL: AL30C/AL30 desde Rava ──
  CCL_EXISTS=$(sb_get "dolar_historico" "fecha=eq.${HOY}&tipo=eq.ccl&select=fecha&limit=1")
  if [ -z "$CCL_EXISTS" ] || [ "$CCL_EXISTS" = "[]" ]; then
    log "INFO dólar: calculando CCL desde Rava..."
    CCL_RESP=$(curl -s -X POST "${SB_URL}/functions/v1/yahoo-prices" \
      -H "Content-Type: application/json" \
      -H "apikey: $SB_KEY" \
      -H "Authorization: Bearer $SB_KEY" \
      -d '{"mode":"rava-series","symbols":["AL30","AL30C"]}' 2>/dev/null)

    if [ -n "$CCL_RESP" ]; then
      AL30_PX=$(echo "$CCL_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
al30 = data.get('AL30', [])
for r in al30:
    if r.get('fecha') == '$HOY' and r.get('cierre', 0) > 0:
        print(r['cierre'])
        break
" 2>/dev/null || echo "0")

      AL30C_PX=$(echo "$CCL_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
al30c = data.get('AL30C', [])
for r in al30c:
    if r.get('fecha') == '$HOY' and r.get('cierre', 0) > 0:
        print(r['cierre'])
        break
" 2>/dev/null || echo "0")

      if [ "$(echo "$AL30_PX > 0" | bc -l 2>/dev/null)" = "1" ] && \
         [ "$(echo "$AL30C_PX > 0" | bc -l 2>/dev/null)" = "1" ]; then
        CCL=$(echo "scale=2; $AL30_PX / $AL30C_PX" | bc -l 2>/dev/null || echo "0")
        if [ "$(echo "$CCL > 0" | bc -l 2>/dev/null)" = "1" ]; then
          sb_post "dolar_historico" "{\"fecha\":\"$HOY\",\"tipo\":\"ccl\",\"close\":$CCL,\"fuente\":\"rava\"}"
          log "INFO dólar: CCL = $CCL"
        fi
      fi
    fi
  fi

  # ── Resumen diario dólar ──
  MEP_VAL=$(sb_get "mep_historico" "fecha=eq.${HOY}&select=mep" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['mep'] if d else 'N/A')" 2>/dev/null || echo "N/A")
  OF_VAL=$(sb_get "dolar_historico" "fecha=eq.${HOY}&tipo=eq.oficial&select=close" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['close'] if d else 'N/A')" 2>/dev/null || echo "N/A")
  CCL_VAL=$(sb_get "dolar_historico" "fecha=eq.${HOY}&tipo=eq.ccl&select=close" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['close'] if d else 'N/A')" 2>/dev/null || echo "N/A")

  FALTANTES=""
  [ "$OF_VAL" = "N/A" ] && FALTANTES="${FALTANTES}Oficial "
  [ "$MEP_VAL" = "N/A" ] && FALTANTES="${FALTANTES}MEP "
  [ "$CCL_VAL" = "N/A" ] && FALTANTES="${FALTANTES}CCL "

  MSG="[Dolar $HOY]\\nOficial: $OF_VAL\\nMEP: $MEP_VAL\\nCCL: $CCL_VAL"
  [ -n "$FALTANTES" ] && MSG="${MSG}\\n\\n⚠️ *Faltante(s):* $FALTANTES" && log "WARN dólar: faltan $FALTANTES"
  send_tg "$MSG"
  log "INFO dólar: resumen enviado — Of=$OF_VAL, MEP=$MEP_VAL, CCL=$CCL_VAL"
fi

# ── Snapshot diario P&L portafolio (17:06–17:59 ARG) ─────
if in_time_range "17:06" "17:59" && [ "$DOW" -le 5 ]; then
  log "INFO PnL: iniciando snapshot diario para $HOY"

  # Obtener MEP de hoy
  MEP_HOY=$(sb_get "mep_historico" "fecha=eq.${HOY}&select=mep" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['mep'] if d else '0')" 2>/dev/null || echo "0")
  if [ "$(echo "$MEP_HOY <= 0" | bc -l 2>/dev/null)" = "1" ]; then
    log "ERROR PnL: sin MEP hoy — PnL no puede calcularse"
  else
    log "INFO PnL: MEP = $MEP_HOY"

    # Obtener todos los usuarios con posiciones activas
    USUARIOS=$(sb_get "portafolio" "activo=eq.true&tipo=neq.OPCION&select=user_email" | \
      python3 -c "
import sys, json
d = json.load(sys.stdin)
emails = sorted(set(r['user_email'] for r in d if r.get('user_email')))
for e in emails:
    print(e)
" 2>/dev/null || true)

    PNL_COUNT=0
    USR_COUNT=0

    for EMAIL in $USUARIOS; do
      USR_COUNT=$((USR_COUNT + 1))

      # Saltar si ya existe el snapshot de hoy
      CHK=$(sb_get "pnl_diario" "user_email=eq.${EMAIL}&fecha=eq.${HOY}&select=fecha&limit=1")
      if [ -n "$CHK" ] && [ "$CHK" != "[]" ]; then
        PNL_COUNT=$((PNL_COUNT + 1))
        continue
      fi

      # Calcular PnL usando node (misma lógica que el frontend)
      # Usamos node porque bash no tiene la lógica de cálculo de posiciones
      node -e "
const path = require('path');
const mod = path.resolve('/mnt/c/dashboard/Github/node_modules/@supabase/supabase-js/dist/index.cjs');
const { createClient } = require(mod);
// Usar anon key por defecto; SUPABASE_SR_KEY env var para service role
const srKey = process.env.SUPABASE_SR_KEY || '${SB_KEY}';
const sb = createClient('${SB_URL}', srKey);
const BONOS = ['BONO_SOBERANO','DOLAR_LINKED','BONO_CER','BONO_DUAL'];
const email = '${EMAIL}';
const hoy = '${HOY}';
const mepHoy = ${MEP_HOY};

(async () => {
  // Posiciones activas
  const posAll = await sb.from('portafolio')
    .select('ticker_ars,tipo,cantidad,fecha_compra')
    .eq('user_email', email).eq('activo', true).neq('tipo', 'OPCION');
  if (!posAll.data || !posAll.data.length) process.exit(0);
  const posExist = posAll.data.filter(p => p.fecha_compra && p.fecha_compra < hoy);

  // Trades CEDEAR cerrados hoy (multi-día)
  let realizedGain = 0;
  try {
    const td = await sb.from('trades')
      .select('ganancia_usd')
      .eq('user_email', email).eq('tipo', 'CEDEAR')
      .eq('fecha_cierre', hoy).lt('fecha_apertura', hoy);
    realizedGain = (td.data||[]).reduce((s,t) => s + Number(t.ganancia_usd||0), 0);
  } catch(e) {}

  // Trades CEDEAR intradía
  let intradayGain = 0;
  try {
    const ti = await sb.from('trades')
      .select('ganancia_usd')
      .eq('user_email', email).eq('tipo', 'CEDEAR')
      .eq('fecha_apertura', hoy).eq('fecha_cierre', hoy);
    intradayGain = (ti.data||[]).reduce((s,t) => s + Number(t.ganancia_usd||0), 0);
  } catch(e) {}

  // Trades abiertos (close > hoy)
  let tradesAbiertos = [];
  try {
    const ta = await sb.from('trades')
      .select('ticker_ars,cantidad')
      .eq('user_email', email).eq('tipo', 'CEDEAR')
      .gt('fecha_cierre', hoy);
    tradesAbiertos = ta.data || [];
  } catch(e) {}

  // Precios de mercado
  const allTickers = [...new Set([
    ...posAll.data.map(p => p.ticker_ars),
    ...tradesAbiertos.map(t => t.ticker_ars)
  ])];
  const tks = allTickers.map(t => '\"' + t + '\"').join(',');
  const pxR = await sb.from('mercado')
    .select('symbol,last')
    .in('symbol', allTickers)
    .eq('settlement', '24hs');
  const px = {};
  (pxR.data||[]).forEach(r => { if(r.last) px[r.symbol] = Number(r.last); });

  // Total USD
  let totalUsd = 0;
  for (const p of posAll.data) {
    const precio = px[p.ticker_ars]; if (!precio) continue;
    const factor = BONOS.includes(p.tipo) ? 100 : 1;
    totalUsd += (Number(p.cantidad) * precio) / (factor * mepHoy);
  }
  for (const t of tradesAbiertos) {
    const precio = px[t.ticker_ars]; if (!precio) continue;
    totalUsd += (Number(t.cantidad) * precio) / mepHoy;
  }
  totalUsd = Math.round(totalUsd * 100) / 100;

  // PnL vs día anterior
  const ayerR = await sb.from('pnl_diario')
    .select('valor_usd')
    .eq('user_email', email).lt('fecha', hoy)
    .order('fecha', { ascending: false }).limit(1);
  let pnlUsd = null, pnlPct = null;
  if (ayerR.data && ayerR.data.length > 0 && Number(ayerR.data[0].valor_usd) > 0) {
    const v0 = Number(ayerR.data[0].valor_usd);
    pnlUsd = Math.round((totalUsd - v0 + realizedGain + intradayGain) * 100) / 100;
    pnlPct = Math.round(pnlUsd / v0 * 100 * 10000) / 10000;
  }

  // Guardar
  const row = { user_email: email, fecha: hoy, valor_usd: totalUsd, pnl_usd: pnlUsd, pnl_pct: pnlPct };
  const h = { apikey: '${SB_KEY}', Authorization: 'Bearer ${SB_KEY}', 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' };
  const res = await fetch('${SB_URL}/rest/v1/pnl_diario', { method:'POST', headers:h, body:JSON.stringify(row) });
  if (res.ok) {
    console.log(email + ': valor_usd=' + totalUsd + ', pnl_usd=' + (pnlUsd||'null'));
  } else {
    console.error(email + ': HTTP ' + res.status);
  }
})().catch(e => { console.error(email + ': ' + e.message); process.exit(1); });
" 2>> "$LOG_FILE" || true

      PNL_COUNT=$((PNL_COUNT + 1))
    done

    log "INFO PnL: $PNL_COUNT/$USR_COUNT usuarios procesados para $HOY"
  fi
fi

# ── Earnings alerts (una vez por día) ─────────────────────
EARN_FLAG="$FLAGS_DIR/earnings_chk_${HOY}.flag"
if [ ! -f "$EARN_FLAG" ]; then
  touch "$EARN_FLAG"

  # Limpiar flags de días anteriores
  find "$FLAGS_DIR" -name 'earnings_chk_*.flag' ! -name "earnings_chk_${HOY}.flag" -delete 2>/dev/null || true

  # Obtener tickers ADR del portafolio
  ADRS=$(sb_get "portafolio" "activo=eq.true&select=ticker_adr&ticker_adr=not.is.null" | \
    python3 -c "
import sys, json
d = json.load(sys.stdin)
adrs = sorted(set(r['ticker_adr'] for r in d if r.get('ticker_adr')))
for a in adrs: print(a)
" 2>/dev/null || true)

  if [ -n "$ADRS" ]; then
    ADR_LIST=$(echo "$ADRS" | tr '\n' ',' | sed 's/,$//')
    ADR_ARRAY=$(echo "$ADRS" | python3 -c "import sys; print(json.dumps(sys.stdin.read().strip().split('\n')))" 2>/dev/null || echo "[]")

    EARN_RESP=$(curl -s -X POST "${SB_URL}/functions/v1/yahoo-prices" \
      -H "Content-Type: application/json" \
      -H "apikey: $SB_KEY" \
      -H "Authorization: Bearer $SB_KEY" \
      -d "{\"mode\":\"earnings\",\"symbols\":$ADR_ARRAY}" 2>/dev/null)

    if [ -n "$EARN_RESP" ]; then
      echo "$EARN_RESP" | python3 -c "
import sys, json
from datetime import date
try:
    data = json.load(sys.stdin)
    today = '$HOY'
    for item in data:
        sym = item.get('symbol', '')
        eDate = item.get('earningsDate', '')
        if not sym or not eDate: continue
        try:
            days = (date.fromisoformat(eDate) - date.fromisoformat(today)).days
        except: continue
        if days < 0 or days > 5: continue
        cuando = 'HOY' if days == 0 else ('mañana' if days == 1 else f'en {days} días')
        print(f'{sym}|{eDate}|{cuando}')
except: pass
" 2>/dev/null | while IFS='|' read -r SYM EDATE CUANDO; do
        FLAG_KEY="$FLAGS_DIR/earnings_${SYM}_${EDATE}.flag"
        [ -f "$FLAG_KEY" ] && continue
        touch "$FLAG_KEY"
        send_tg "[Earnings] *${SYM}* reporta *${CUANDO}* (${EDATE})\\nRevisá posición antes del anuncio."
      done
    fi
  fi
fi

log "=== monitor_dashboard.sh fin ==="
