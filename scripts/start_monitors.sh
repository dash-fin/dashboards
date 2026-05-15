#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Launcher de monitores WSL
# Arranca monitor_local.sh y monitor_usa.sh como background
# ═══════════════════════════════════════════════════════════
# Uso: bash scripts/start_monitors.sh
# ═══════════════════════════════════════════════════════════

BASEDIR="$(cd "$(dirname "$0")/.." && pwd)"

# Verificar que las variables de entorno estén seteadas
if [[ -z "${SUPABASE_SR_KEY}" || -z "${TG_TOKEN}" ]]; then
  echo "Error: SUPABASE_SR_KEY y TG_TOKEN deben estar definidas"
  echo "Ej: SUPABASE_SR_KEY='...' TG_TOKEN='...' bash scripts/start_monitors.sh"
  exit 1
fi

export SUPABASE_SR_KEY TG_TOKEN

echo "Arrancando monitor_local.sh..."
nohup bash "${BASEDIR}/scripts/monitor_local.sh" >> "${BASEDIR}/scripts/monitor_local.log" 2>&1 &
echo "PID: $!"

echo "Arrancando monitor_usa.sh..."
nohup bash "${BASEDIR}/scripts/monitor_usa.sh" >> "${BASEDIR}/scripts/monitor_usa.log" 2>&1 &
echo "PID: $!"

echo ""
echo "✅ Monitores arrancados. Ver logs:"
echo "  tail -f scripts/monitor_local.log"
echo "  tail -f scripts/monitor_usa.log"
echo ""
echo "Para matar: kill $(jobs -p)"
