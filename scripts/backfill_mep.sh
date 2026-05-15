#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Backfill MEP histórico usando AL30D/AL30H
# Calcula MEP en base a cotización real de bonos dollar-linked
# ═══════════════════════════════════════════════════════════
# Uso: ./backfill_mep.sh [desde_fecha]
# Ej:  ./backfill_mep.sh 2025-01-01
# ═══════════════════════════════════════════════════════════

set -euo pipefail

SB_URL="https://endymbpdayeidromxayb.supabase.co"
SB_KEY="${SUPABASE_SR_KEY:?SUPABASE_SR_KEY no definida}"
DESDE="${1:-2024-01-01}"

SB_HEADERS=(-H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY")
SB_POST_HEADERS=(-H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates")

log() { echo "[$(TZ=America/Argentina/Buenos_Aires date '+%Y-%m-%d %H:%M:%S')] $*"; }
sb_get() { curl -s -G "${SB_URL}/rest/v1/$1" "${SB_HEADERS[@]}" --data-urlencode "$2" 2>/dev/null; }
sb_post() { curl -s -X POST "${SB_URL}/rest/v1/$1" "${SB_POST_HEADERS[@]}" -d "$2" 2>/dev/null; }

log "Backfill MEP desde $DESDE"

# Obtener fechas con operaciones que NO tienen MEP
FECHAS=$(sb_get "operaciones" "select=fecha_compra&fecha_compra=gte.${DESDE}&order=fecha_compra.asc&limit=500" | \
  grep -oP '"fecha_compra":"\K[^"]+' | sort -u)

for FECHA in $FECHAS; do
  # Ver si ya existe MEP
  EXISTE=$(sb_get "mep_historico" "select=fecha&fecha=eq.${FECHA}&limit=1")
  if [[ -n "$EXISTE" && "$EXISTE" != "[]" ]]; then
    continue
  fi

  log "Consultando $FECHA..."

  # Obtener precio de AL30D y AL30 para esa fecha via edge function
  RESP=$(curl -s -m 15 "https://endymbpdayeidromxayb.supabase.co/functions/v1/yahoo-prices" \
    -H "Content-Type: application/json" \
    -d "$(echo "{\"action\":\"history\",\"symbols\":[\"AL30D.BA\",\"AL30.BA\"],\"from\":\"${FECHA}\",\"to\":\"${FECHA}\"}")" 2>/dev/null)

  if [[ -z "$RESP" || "$RESP" == "[]" || "$RESP" == "{}" ]]; then
    log "  Sin datos para $FECHA"
    continue
  fi

  # Extraer precios
  AL30D_CLOSE=$(echo "$RESP" | grep -oP "AL30D\.BA.*?close\":\K[\d.]+" | head -1)
  AL30_CLOSE=$(echo "$RESP" | grep -oP "AL30\.BA.*?close\":\K[\d.]+" | head -1)

  if [[ -z "$AL30D_CLOSE" || -z "$AL30_CLOSE" || "$AL30_CLOSE" == "0" ]]; then
    log "  Precios incompletos para $FECHA (AL30D=$AL30D_CLOSE, AL30=$AL30_CLOSE)"
    continue
  fi

  MEP=$(echo "scale=2; $AL30D_CLOSE / $AL30_CLOSE" | bc)
  log "  $FECHA: MEP=$MEP (AL30D=$AL30D_CLOSE, AL30=$AL30_CLOSE)"

  # Guardar en mep_historico
  PAYLOAD=$(cat <<JSON
{"fecha":"$FECHA","mep":$MEP,"mep_al30":$MEP}
JSON
)
  sb_post "mep_historico" "$PAYLOAD" > /dev/null
done

log "Backfill MEP completado"
