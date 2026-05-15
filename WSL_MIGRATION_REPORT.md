# Informe de Migración Windows → WSL

**Fecha:** 2026-05-15
**Autor:** Claude (subagent de auditoría)
**Repositorio:** `/mnt/c/dashboard/Github`

---

## Resumen

| Indicador | Valor |
|-----------|-------|
| Tareas Windows identificadas | **9** |
| Migradas completamente a WSL | **6** ✅ |
| Migradas parcialmente | **2** ⚠️ |
| No migradas (solo Windows) | **1** ❌ |
| Scripts sobrantes de Windows | **3 archivos + flags** |

---

## Tareas Windows detectadas

| # | Tarea | Script Windows | Horario (ART) | Script WSL | Estado |
|---|-------|---------------|---------------|------------|--------|
| 1 | **Watchdog ARS** | `monitor_dashboard.ps1` | lun-vie 10:40-16:59 | `monitor_local.sh` | ✅ Completo |
| 2 | **Watchdog USA** | `monitor_dashboard.ps1` | lun-vie 08:10-20:30 | `monitor_usa.sh` | ✅ Completo |
| 3 | **Dólar MEP (cierre)** | `monitor_dashboard.ps1` | 17:01-17:59 | `monitor_local.sh` | ✅ Completo |
| 4 | **Dólar oficial (cierre)** | `monitor_dashboard.ps1` | 17:01-17:59 | `monitor_local.sh` | ✅ Completo |
| 5 | **Dólar CCL (cierre)** | `monitor_dashboard.ps1` | 17:01-17:59 | `monitor_local.sh` | ✅ Completo |
| 6 | **Resumen diario dólar** | `monitor_dashboard.ps1` | 17:01-17:59 | `monitor_local.sh` | ✅ Completo |
| 7 | **PnL snapshot** | `monitor_dashboard.ps1` | 17:06-17:59 | `monitor_local.sh` | ⚠️ Parcial |
| 8 | **Earnings alerts** | `monitor_dashboard.ps1` | 1x/día (horario libre) | `monitor_usa.sh` | ⚠️ Parcial |
| 9 | **Monitor batería** | `monitor_dashboard.ps1` | Siempre (cada 5 min) | — | ❌ Faltante |

### Tareas adicionales WSL (no existían en Windows)

| # | Tarea | Script WSL | Propósito |
|---|-------|-----------|-----------|
| A | **Health check edge function** | `monitor_usa.sh` | Verifica que yahoo-prices responda |
| B | **Dólar blue (ArgentinaDatos)** | `monitor_local.sh` | Captura cotización blue |
| C | **Backfill PnL calendario** | `backfill_calendario.sh` | Rellena días hábiles faltantes |
| D | **Backfill MEP histórico** | `backfill_mep.sh` | Backfill MEP usando AL30D/AL30 |
| E | **Short volume FINRA** | `load_short_volume.py` | Carga short volume vía SQL Management API |
| F | **Dólar backfill** | `scripts/backfill_dolar.py` | Backfill oficial, MEP, CCL a `dolar_historico` |
| G | **PnL backfill** | `backfill_pnl.py` (raíz) | Backfill pnl_diario para `elyagui@gmail.com` |

---

## Detalle por tarea

### 1. Watchdog ARS

**Windows (`monitor_dashboard.ps1`):**
- Verifica que tabla `mercado` tenga datos frescos (< 7 min)
- Si datos viejos → reinicia Task Scheduler `\Dashboard`, envía alerta Telegram
- Usa flag file `wd_ars.flag` para evitar spam
- Activo lun-vie 10:40-16:59 ART

**WSL (`monitor_local.sh`):**
- Verifica frescura de `created_at` en tabla `mercado` (< 7 min)
- Loggea alerta pero NO reinicia nada ni envía Telegram automático
- No usa flag files
- Activo lun-vie 10:40-18:00 ART (media hora extra al cierre ✅)

**Brecha:** ⚠️ En Windows el watchdog **reiniciaba la tarea** automáticamente + avisaba por Telegram. En WSL solo loggea. No hay mecanismo de autoreinicio (en WSL el monitor lo corre crontab, que no se puede "reiniciar" desde dentro).

---

### 2. Watchdog USA

**Windows (`monitor_dashboard.ps1`):**
- Verifica frescura de tabla `mercado_usa` (< 7 min)
- Reinicia Task Scheduler `\Dashboard USA`, alerta Telegram
- Activo lun-vie 08:10-20:30 ART

**WSL (`monitor_usa.sh`):**
- Verifica frescura de `mercado_usa` (< 7 min)
- Loggea alerta, sin autoreinicio
- Horario exacto: 08:10-20:30 ART ✅

**Brecha:** Misma que Watchdog ARS — sin autoreinicio automático. Sin embargo, añade **health check de edge function** que no existía en Windows. Es un net improvement parcial.

---

### 3. Dólar MEP (cierre)

**Windows (`monitor_dashboard.ps1`):**
- 17:01-17:59: Obtiene AL30/AL30D desde edge function `yahoo-prices` (modo `rava-series`)
- Calcula MEP = AL30 ARS / AL30D USD
- Guarda en `mep_historico` y `dolar_historico` (tipo="mep")
- Evita duplicados (checks si ya existe fecha)

**WSL (`monitor_local.sh`):**
- 17:01-17:59: Obtiene AL30/AL30D desde edge function pero usando **mode `quote`** en vez de `rava-series`
- Calcula MEP = AL30D ARS / AL30 USD
- Guarda en `mep_historico` y `dolar_historico` (tipo="mep")
- También guarda blue (no existía en Windows)

**⚠️ Diferencia crítica:** El cálculo WSL usa `quote` (precio en vivo) mientras Windows usaba `rava-series` (cierre histórico de Rava). Al cierre del mercado (17:00), `quote` devuelve el último precio de Yahoo de AL30D.BA/AL30.BA, NO el cierre oficial de BYMA. Además, en WSL calcula como **AL30D / AL30** (dolar-linked / soberano), mientras Windows calculaba como **AL30 / AL30D** (soberano / dolar-linked). **Esto da el inverso — el resultado puede ser totalmente distinto.**

✅ Datos guardados en mismas tablas. ✅ Sin duplicados.

---

### 4. Dólar oficial (cierre)

**Windows (`monitor_dashboard.ps1`):**
- 17:01-17:59: ArgentinaDatos API → `dolar_historico` tipo="oficial"
- 2 retries + sleep 5s entre intentos
- Fallback BCRA (variable 4) si ArgentinaDatos no tiene el día
- Log detallado

**WSL (`monitor_local.sh`):**
- 17:01-17:59: ArgentinaDatos API → extrae con grep
- Sin retries, sin fallback BCRA
- Sin logging detallado de errores

**Brecha:** ⚠️ Sin retries ni fallback BCRA. Si ArgentinaDatos falla, se pierde el dato del día.

---

### 5. Dólar CCL (cierre)

**Windows (`monitor_dashboard.ps1`):**
- 17:01-17:59: Edge function `yahoo-prices` modo `rava-series` con AL30/AL30C
- Busca cierre oficial por fecha exacta, con preferencia CT (contado)
- 2 retries con sleep 5s
- Guarda en `dolar_historico` tipo="ccl"

**WSL (`monitor_local.sh`):**
- 17:01-17:59: Edge function modo `quote` con AL30.BA / AL30C — extrae con grep del mismo response que MEP
- Sin retries, sin sleep, sin preferencia CT
- Guarda en `dolar_historico` tipo="ccl"

**Brecha:** ⚠️ Sin retries. La extracción con grep sobre JSON es frágil. Sin preferencia CT sobre otras especies.

---

### 6. Resumen diario dólar

**Windows (`monitor_dashboard.ps1`):**
- Después del cierre: lee oficial, MEP, CCL desde DB
- Detecta faltantes y los reporta en el mensaje
- Envía a Telegram con formato Markdown

**WSL (`monitor_local.sh`):**
- A las 17:20: envía resumen con formato HTML
- Lee de `mep_historico` (unifica mep+oficial+ccl+blue en un row)
- NO detecta faltantes explícitamente
- Incluye blue (nuevo)

**Brecha:** Menor — WSL no reporta faltantes. ✅ Incluye blue. ✅ Lógica similar.

---

### 7. PnL snapshot ⚠️

**Windows (`monitor_dashboard.ps1`):**
- 17:06-17:59: Snapshot completo de portafolio para **múltiples usuarios**
  - Lee de `portafolio` (tabla antigua, no `operaciones`)
  - Cruza con `mercado` para precios actuales (settlement=24hs)
  - Calcula valor_usd = sum(precio_ars * cantidad / factor / MEP)
  - Incluye trades multi-día cerrados, intradía, y abiertos
  - Calcula pnl_usd y pnl_pct vs día anterior
  - **3 retries al cargar usuarios** (fix mayo-2026)
  - Verifica frescura de precios de mercado antes de calcular
  - Multiplexa por user_email (varios usuarios)

**WSL (`monitor_local.sh`):**
- 17:06-17:59: Snapshot usando **tabla `operaciones` en vez de `portafolio`**
  - Usa `prima_usd` como precio (NO precio de mercado actual ✗)
  - Soporta posiciones largas (COMPRA) y cortas (VENTA)
  - Solo diferencia por tipo de operación, no por tipo de activo
  - **NO aplica factor /100 para bonos** ✗
  - **NO calcula trades cerrados** ✗
  - **NO calcula pnl_usd correctamente** (usa prima_usd como precio actual, no last de mercado) ✗
  - **Guarda campos diferentes** (`inversiones`, `pnl_operaciones`) aparte de `valor_usd`
  - Intentó usar precios de mercado pero el código embedded Node.js **está incompleto** (fetch a yahoo-prices sin símbolos, comentarios confusos)

**Brecha:** ❌ **GRANDE.** El PnL de WSL usa `operaciones` (tabla nueva/diferente), `prima_usd` como precio (incorrecto — debería ser precio de mercado actual), y no calcula pnl correctamente. El código Node.js inline parece un esqueleto incompleto. Los campos guardados son distintos.

---

### 8. Earnings alerts ⚠️

**Windows (`monitor_dashboard.ps1`):**
- Una vez por día, horario libre
- Obtiene ADRs desde `portafolio` (columna `ticker_adr`)
- Edge function `yahoo-prices` modo `earnings`
- Flag por ticker+fecha para no repetir
- Alerta a Telegram con días hasta earnings

**WSL (`monitor_usa.sh`):**
- Ejecuta 3 veces al día (09:30, 12:00, 16:00 ART)
- Obtiene ADRs desde `operaciones` (columna `ticker`, no `ticker_adr`)
- Edge function `yahoo-prices` con action="earnings"
- Flag file `/tmp/monitor_usa_earnings_sent.txt`
- Parseo con grep más frágil (vs JSON.parse en PowerShell)
- Alerta próxima ventana de 14 días

**Brecha:** ⚠️ Usa `operaciones` con `ticker_ars LIKE "*ADR*"` + fallback a `watchlist`. En Windows usaba columna explícita `ticker_adr` desde `portafolio`. La fuente de tickers es diferente. Parseo con grep frágil. Múltiples ejecuciones por día (Windows: 1x).

---

### 9. Monitor batería ❌

**Windows (`monitor_dashboard.ps1`):**
- Cada 5 min: lee batería con `Get-CimInstance Win32_Battery`
- Alertas Telegram a 20% y 10%
- Flags para no repetir
- Resetea flags cuando se conecta cargador

**WSL (`monitor_local.sh` y `monitor_usa.sh`):**
- ❌ **No implementado.** No hay equivalente en bash/WSL.

**Brecha:** ❌ **Completamente faltante.** No hay script WSL que monitoree batería. Tampoco hay sentido práctico — WSL corre en un servidor/PC, rara vez tiene sentido de batería desde Linux. Es una tarea que hay que **desactivar en Windows** manualmente.

---

## Scripts adicionales (Windows → WSL)

### Backfill dólar (scripts/backfill_dolar.py)

**Windows:** PS script no tenía backfill dólar — solo capturaba el día actual en `monitor_dashboard.ps1`.

**WSL:** `scripts/backfill_dolar.py` es un script Python completo que:
- Backfill oficial desde ArgentinaDatos (toda la data disponible)
- Backfill MEP desde `mep_historico`
- Backfill CCL desde Rava (AL30/AL30C) vía edge function
- Usa upsert con merge-duplicates
- Lotes de 500 registros
- ✅ **Solo WSL, no existía en Windows.**

### PnL backfill (backfill_pnl.py en raíz)

**Windows:** `Scripts/backfill_pnl.py` (en Windows, bajo `Scripts/`) — mismo archivo que ahora está desplazado a raíz del repo.

**WSL:** Existe en raíz del repo, no dentro de `scripts/`. Hace backfill de `pnl_diario` para `elyagui@gmail.com` usando rava-series + MEP histórico. **Misma lógica.** ✅

### Backfill calendario PnL (scripts/backfill_calendario.sh)

**WSL:** Nuevo script bash que rellena pnl_diario para fechas con MEP disponible pero sin PnL. Usa Node.js inline para cálculo. ✅ **Solo WSL.**

### Backfill MEP (scripts/backfill_mep.sh)

**WSL:** Nuevo script bash que calcula MEP histórico usando AL30D/AL30H desde Yahoo Finance vía edge function. ✅ **Solo WSL.**

### Short volume FINRA (scripts/load_short_volume.py)

**WSL:** Carga diaria short volume FINRA via SQL Management API (evita REST 409). Carga últimos ~60 días hábiles. ✅ **Solo WSL.**

### process_iamc.py (scripts/process_iamc.py)

**Windows:** Existía en `Scripts/process_iamc.py`.
**WSL:** Mismo archivo en `scripts/process_iamc.py`. ✅ Migrado correctamente.

---

## Tablas de datos — comparación Windows vs WSL

### Tablas que escribe `monitor_dashboard.ps1` (Windows)
| Tabla | Columnas típicas | Sigue escribiendo WSL? |
|-------|-----------------|----------------------|
| `mercado` | — | **No escribe** — el monitor no escribe en mercado (es de solo lectura) |
| `mercado_usa` | — | **No escribe** — igual |
| `mep_historico` | fecha, mep, al30_ars, al30d_usd, fuente | ✅ `monitor_local.sh` escribe |
| `dolar_historico` | fecha, tipo, close, fuente | ✅ `monitor_local.sh` escribe |
| `pnl_diario` | user_email, fecha, valor_usd, pnl_usd, pnl_pct | ⚠️ `monitor_local.sh` escribe pero con campos distintos |

### Tablas que escribe `monitor_local.sh` (WSL)
| Tabla | Campos adicionales |
|-------|-------------------|
| `mep_historico` | Añade columnas `oficial`, `ccl`, `blue` (no existían en PS) |
| `dolar_historico` | Añade tipo "blue" (solo WSL) |
| `pnl_diario` | Añade campos `pnl_operaciones`, `inversiones`, usa campo `email` (no `user_email`) |

---

## Recomendaciones

### 1. Qué tareas de Windows hay que desactivar

**Tarea crítica — desactivar YA:**
```powershell
# En PowerShell como Admin en Windows
Unregister-ScheduledTask -TaskName "monitor_dashboard" -Confirm:$false
```
- Esta tarea corre `monitor_dashboard.ps1` cada 5 min
- Su PnL snapshot y dólar compiten/confluyen con WSL
- La batería no aplica en WSL

### 2. Qué scripts de Windows ya no hacen falta

| Script Windows | Acción |
|----------------|--------|
| `scripts/monitor_dashboard.ps1` | **No borrar aún** — mantener como referencia por un mes. Luego eliminar. |
| `scripts/monitor_dashboard.sh` | Ya eliminado del repo (git status muestra D). OK. |
| Flag files (`*.flag`) | Se creaban en `PSScriptRoot` en Windows. Si quedaron en Windows, se pueden limpiar. |

### 3. Qué falta implementar

**Prioridad alta:**
1. **PnL snapshot correcto en WSL** — `monitor_local.sh` necesita reescribir la función `pnl_snapshot()` para:
   - Usar `portafolio` (o migrar a `operaciones` pero con precios de mercado reales)
   - Aplicar factor /100 para bonos
   - Usar precios de `mercado` (last, settlement=24hs), no `prima_usd`
   - Calcular trades cerrados multi-día
   - Soportar múltiples usuarios
   - Usar `user_email` como PK (no `email`)
   - Calcular pnl_usd y pnl_pct correctamente
   - **Considerar migrar a Node.js o Python** en vez de shell con Node inline

2. **Watchdog con alerta Telegram** — `monitor_local.sh` y `monitor_usa.sh` deberían enviar alerta Telegram cuando detectan datos viejos, como hacía Windows (flag file + reinicio + alerta). El reinicio es discutible (crontab se auto-ejecuta), pero la alerta es valiosa.

3. **Dólar: retries y fallback** — Agregar retries con sleep para oficial/CCL, y fallback BCRA para oficial como tenía Windows.

**Prioridad media:**
4. **Earnings: estandarizar fuente** — Decidir si se usa `portafolio.ticker_adr` (Windows) u `operaciones.ticker` (WSL). Son tablas distintas. Si se migró a `operaciones`, actualizar para que funcione correctamente.

5. **Earnings: parseo más robusto** — El grep en WSL es frágil. Usar `jq` para parsear JSON de manera confiable con bash.

6. **Resumen diario con detección de faltantes** como tenía Windows.

**Prioridad baja:**
7. **Monitor batería** — No aplica a WSL. Simplemente desactivar en Windows.

### 4. Instrucciones para poner en producción desde WSL

```bash
# 1. Configurar crontab
crontab -e

# Agregar líneas:
SUPABASE_SR_KEY="<tu-service-role-key>"
TG_TOKEN="<tu-telegram-bot-token>"
TG_CHAT_ID="6209263987"

# Monitor ARS (cada 5 min, lun-vie)
*/5 * * * 1-5 SUPABASE_SR_KEY="$SUPABASE_SR_KEY" TG_TOKEN="$TG_TOKEN" TG_CHAT_ID="$TG_CHAT_ID" \
  /mnt/c/dashboard/Github/scripts/monitor_local.sh \
  >> /mnt/c/dashboard/Github/scripts/monitor_local.log 2>&1

# Monitor USA (cada 5 min, lun-vie)
*/5 * * * 1-5 SUPABASE_SR_KEY="$SUPABASE_SR_KEY" TG_TOKEN="$TG_TOKEN" TG_CHAT_ID="$TG_CHAT_ID" \
  /mnt/c/dashboard/Github/scripts/monitor_usa.sh \
  >> /mnt/c/dashboard/Github/scripts/monitor_usa.log 2>&1

# Short volume FINRA (diario 17:15, lun-vie)
15 17 * * 1-5 SUPABASE_SR_KEY="$SUPABASE_SR_KEY" \
  /usr/bin/python3 /mnt/c/dashboard/Github/scripts/load_short_volume.py \
  >> /mnt/c/dashboard/Github/scripts/finra_short_volume.log 2>&1

# 2. Verificar que las variables de entorno están disponibles
# (O bien hardcodear en crontab, como sugiere arquitectura.html)

# 3. Test rápido manual
TG_TOKEN="$TG_TOKEN" SUPABASE_SR_KEY="$SUPABASE_SR_KEY" \
  /mnt/c/dashboard/Github/scripts/monitor_local.sh

# 4. Revisar logs
tail -f /mnt/c/dashboard/Github/scripts/monitor_local.log
tail -f /mnt/c/dashboard/Github/scripts/finra_short_volume.log
```

**Nota:** El crontab actual del usuario está vacío. Hay que instalarlo manualmente.

---

## Issue crítico: Tabla `portafolio` vs `operaciones`

Windows usa `portafolio` como tabla de posiciones. WSL (scripts más nuevos) usa `operaciones`:

| Script | Tabla que usa |
|--------|--------------|
| `monitor_dashboard.ps1` | `portafolio` (con user_email) |
| `monitor_local.sh` (PnL) | `operaciones` (con email) |
| `backfill_calendario.sh` | `operaciones` (con email) |
| `backfill_mep.sh` | `operaciones` (fechas de compra) |
| `monitor_usa.sh` (earnings) | `operaciones` + `watchlist` |
| `backfill_pnl.py` (raíz) | `portafolio` + `trades` |
| `portafolio_seed.py` | `portafolio` |

**Hay dos fuentes de verdad para posiciones.** El PnL diario de WSL escribe campos distintos (`email` vs `user_email`, `inversiones` extra) que el de Windows. **Esto puede causar datos inconsistentes en `pnl_diario`.**

---

## Anexo: Archivos a revisar/limpiar

| Archivo | Estado |
|---------|--------|
| `scripts/monitor_dashboard.ps1` | Reemplazado, mantener como ref |
| `scripts/monitor_dashboard.sh` | Ya borrado del repo |
| `Scripts/backfill_dolar.py` (Windows) | Migrado a `scripts/backfill_dolar.py` |
| `Scripts/backfill_pnl.py` (Windows) | Migrado a raíz `backfill_pnl.py` |
| `*.flag` files (Windows `PSScriptRoot`) | Ya no se crean, limpiar en Windows |
