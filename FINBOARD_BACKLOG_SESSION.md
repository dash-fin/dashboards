# FINBOARD — Backlog para continuar en sesión local

> **IMPORTANTE**: Esta sesión debe iniciarse desde WSL local apuntando al directorio
> correcto. Usar **th0th (Google Drive MCP)** para ubicar los directorios de la app
> móvil si no están a mano. El path conocido es `/mnt/c/dashboard/Github/finboard-app`.
> Sin acceso al disco local, no se puede trabajar en la app móvil.

---

## Contexto del proyecto

Hay **dos apps separadas**:

| App | Path local | Repo |
|-----|-----------|------|
| Web dashboard | `/mnt/c/dashboard/Github/` | `dash-fin/dashboards` (GitHub) |
| App móvil (React Native / Expo) | `/mnt/c/dashboard/Github/finboard-app` | No está en GitHub |

**Supabase**: proyecto `endymbpdayeidromxayb` · usuario `elyagui@gmail.com`

---

## Estado al cierre de esta sesión

### ✅ Ya hecho
- **Edge function v3** (`opciones-chain`) deployada y activa — OI=0 resuelto
- **`alertas.html`** (web): suscripción Realtime a `alertas_historial` + toast de
  notificación en vivo (commit `dbbabbe` en branch `claude/finboard-backlog-review-btJpp`)

### ⚠️ Pendiente manual (1 vez en Supabase SQL Editor)
```sql
ALTER PUBLICATION supabase_realtime ADD TABLE alertas_historial;
```
Sin esto las notificaciones en vivo del web no funcionan aunque el código esté bien.

### ✅ Ya estaba implementado en el web (no necesitaban fix)
- **#2** PnL antes de cerrar opción → preview en modal de cierre
- **#3** PnL en posiciones abiertas → calcula con RT + Black-Scholes fallback
- **#4** Ganancia en todas las posiciones → tabla muestra `gan` (USD) para
  stocks/CEDEARs y `pnlARS` para opciones
- **#1** Date picker → ya usa `<input type="date">` nativo
- **#5** Historial web → ya lee de `trades` + `operaciones` cerradas (ambas tablas)

---

## Backlog completo — App móvil (React Native / Expo)

> Todo lo siguiente hay que resolverlo en el código de `finboard-app`.
> Usar th0th para encontrar los archivos si hace falta.

### Portafolio / posiciones
1. **Date picker al cargar posición** — el campo de fecha usa texto libre; cambiar a
   calendario nativo (`DateTimePicker` de Expo)
2. **PnL antes de cerrar una opción** — mostrar la ganancia/pérdida calculada en el
   modal de cierre antes de confirmar
3. **PnL en posiciones de opciones abiertas** — actualmente no se muestra PnL
   en tiempo real para opciones abiertas en la lista de posiciones
4. **Ganancia en TODAS las posiciones antes de cierre** — mostrar PnL no realizado
   para todas las posiciones del portafolio (no solo opciones)
5. **Trades de Galicia cargados desde la web no aparecen en historial de la app**
   → **Diagnóstico hecho**: la app lee solo tabla `trades`; las opciones cerradas
   desde la web van a tabla `operaciones` (estado='cerrada'). El PnL está en
   `patas[].prima_cierre` (JSON), no en `pnl_realizado`. Fix: mergear `operaciones`
   cerradas en el historial de la app + calcular PnL desde `patas`.

### Comportamiento / UX
6. **Notificaciones no andan**
   → **Diagnóstico hecho**: `alertas_historial` no estaba en la publicación Realtime
   de Supabase (solo `mercado`). El canal filtra por `user_id` pero el motor de
   alertas escribe por `user_email` → posible `user_id` null en filas. Fix:
   - Ejecutar el SQL del punto anterior
   - Revisar setup de `expo-notifications` en la app + suscripción realtime
   - Verificar que `user_id` se popule en filas nuevas de `alertas_historial`
7. **Lock se hace tarde** — al abrir la app se ven datos brevemente antes de que
   active el bloqueo biométrico. Debe bloquear ANTES de mostrar cualquier dato.
8. **Scroll del home se traba** por momentos — investigar causa (FlatList, re-renders)
9. **Doble tap en cualquier lado = refresh** — implementar gesture de doble tap
   global para refrescar datos
10. **Refresh sin saltar de posición** — si estás en la lista de seguimiento y
    refresca, debe quedarse en esa misma pantalla/posición (no saltar a otra)

### Ya pendientes de antes
11. **Opciones OI=0** → ✅ resuelto con edge function v3
12. **Scroll tras lock vuelve arriba** → fix con `AppState` listener: al volver del
    lock, restaurar la posición del scroll
13. **Paso B: pantalla visual de OI con barras** — nueva pantalla en el módulo de
    opciones mostrando Open Interest por strike con barras horizontales (call vs put),
    destacando Call Wall y Put Wall

---

## Diagnósticos de datos (Supabase) ya hechos

### Tablas relevantes
- `trades` — trades cerrados de la app (stocks, CEDEARs, ADRs). Filtrado por
  `user_email`. La app lo lee para el historial.
- `operaciones` — estrategias de opciones. Estados: `abierta` / `cerrada`.
  Filtrado por `user_id`. La app NO lo lee para el historial → **bug #5**.
- `alertas_historial` — historial de alertas disparadas por el engine.
  Tiene `user_id` y `user_email`. No estaba en publicación Realtime → **bug #6**.

### Estructura de `patas` (JSON en `operaciones`)
```json
{
  "kind": "call" | "put",
  "action": "buy" | "sell",
  "strike": 7055.3,
  "vto": "06/2026",
  "prima": 150.0,
  "qty": 10,
  "option_size": 100,
  "symbol": "GGAL260620C7055",
  "prima_cierre": 280.0   ← solo cuando está cerrada
}
```
El PnL realizado se calcula como:
```
Σ (action=='buy' ? 1 : -1) * (prima_cierre - prima) * qty * option_size
```

---

## Credenciales (para scripts / edge functions)

- **Supabase URL**: `https://endymbpdayeidromxayb.supabase.co`
- **Publishable key**: en `index.html` → `CFG.SB_KEY`
- **Management token** (`sbp_`): en `/mnt/c/dashboard/Github/scripts/load_short_volume.py`
- **Telegram**: token y chat_id en `index.html` → `CFG.TG_TOKEN` / `CFG.TG_CHAT_ID`
