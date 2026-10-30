// ══════════════════════════════════════════════════════════════════
// Supabase Edge Function: alertas-engine
// Cron: evalua alertas cada ~30s contra precios de mercado/usa/opciones
// Envía notificaciones por Telegram / WhatsApp cuando se disparan
// ══════════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SB_URL = Deno.env.get('SUPABASE_URL')!
// Las legacy keys (anon/service_role JWT) fueron deshabilitadas el 2026-05-26.
// Usar las NUEVAS API keys (secret = service_role, publishable = anon).
const SB_SERVICE_KEY = Deno.env.get('SB_SECRET_KEY')!
const sb = createClient(SB_URL, SB_SERVICE_KEY)

// Misma funcion desplegada en A (principal) y B (respaldo), cada una contra su propia DB.
// La instancia de B solo actua si A esta caido (402/timeout); si A responde, A se encarga
// y B se saltea para no duplicar pushes/Telegram. PEER_* = URL + service key de A (secrets de B).
const PEER_URL = Deno.env.get('PEER_SB_URL') || ''
const PEER_KEY = Deno.env.get('PEER_SB_KEY') || ''
async function peerEstaSano(): Promise<boolean> {
  if (!PEER_URL || !PEER_KEY) return false
  try {
    const r = await fetch(`${PEER_URL}/rest/v1/flujo_alertas_config?select=id&limit=1`, {
      headers: { apikey: PEER_KEY, Authorization: 'Bearer ' + PEER_KEY },
      signal: AbortSignal.timeout(4000),
    })
    return r.ok
  } catch { return false }
}

interface Alerta {
  id: string
  user_id: string
  ticker: string
  tipo: string           // precio | ma | variacion | volumen
  params: Record<string, any>  // { dir: 'gt'|'lt'|'gte'|'lte'|'eq', valor: number, mensaje?: string, cooldown?: number }
  activa: boolean
  last_fired: string | null
  fired_count: number
  created_at: string
}

// Obtener condición y valor desde params
function getCond(a: Alerta): string {
  // Acepta tanto códigos ({gt,lt,gte,lte,eq}) como operadores literales ('>','<','>=','<=','=')
  // para no caer al fallback '>' con alertas viejas (ej. SL guardado con dir:'<=' disparaba como TP).
  const dirMap: Record<string, string> = {
    gt: '>', lt: '<', gte: '>=', lte: '<=', eq: '=',
    '>': '>', '<': '<', '>=': '>=', '<=': '<=', '=': '=',
  }
  return dirMap[a.params?.dir] || '>'
}
function getValor(a: Alerta): number {
  const v = a.params?.valor ?? a.params?.val ?? 0
  return Number(v)
}
function getCanal(a: Alerta): string {
  return a.params?.canal || 'ambos'
}
function getCooldown(a: Alerta): number {
  return Number(a.params?.cooldown ?? a.cooldown ?? 0)
}

interface Precio {
  symbol: string
  last: number
  change?: number
  change_pct?: number
  turnover?: number
  bid?: number
  settlement?: string
}

// ── UTILS ──────────────────────────────────────────────
function cleanTicker(s: string): string {
  return s?.trim().toUpperCase().replace(/\s+/g, ' ') || ''
}

function fmtARS(v: number, d = 2): string {
  return '$ ' + v.toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d })
}

function fmtUSD(v: number): string {
  return '$ ' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ── EVALUADORES ───────────────────────────────────────
function evalPrecio(cur: number, valor: number, cond: string): [boolean, string] {
  if (cond === '>')       return [cur > valor,  `${fmtARS(cur)} > ${fmtARS(valor)}`]
  if (cond === '<')       return [cur < valor,  `${fmtARS(cur)} < ${fmtARS(valor)}`]
  if (cond === '>=')      return [cur >= valor, `${fmtARS(cur)} ≥ ${fmtARS(valor)}`]
  if (cond === '<=')      return [cur <= valor, `${fmtARS(cur)} ≤ ${fmtARS(valor)}`]
  if (cond === '=')       return [cur === valor, `${fmtARS(cur)} = ${fmtARS(valor)}`]
  return [false, '']
}

// Evalúa dos condiciones con OR: si alguna se cumple, dispara la alerta
function evalPrecioOr(cur: number, valor: number, cond: string, orValor: number, orCond: string): [boolean, string] {
  const [ok1, desc1] = evalPrecio(cur, valor, cond)
  const [ok2, desc2] = evalPrecio(cur, orValor, orCond)
  if (ok1 || ok2) {
    const parts: string[] = []
    if (ok1) parts.push(desc1)
    if (ok2) parts.push(desc2)
    return [true, parts.join(' OR ')]
  }
  return [false, `${desc1} OR ${desc2}`]
}

function evalVariacion(change: number, valor: number, cond: string): [boolean, string] {
  if (cond === '>')       return [Math.abs(change) > valor,  `Variación ${change >= 0 ? '+' : ''}${change.toFixed(2)}% > ${valor}%`]
  if (cond === '<')       return [Math.abs(change) < valor,  `Variación ${change >= 0 ? '+' : ''}${change.toFixed(2)}% < ${valor}%`]
  if (cond === '>=')      return [Math.abs(change) >= valor, `Variación ${change >= 0 ? '+' : ''}${change.toFixed(2)}% ≥ ${valor}%`]
  if (cond === '<=')      return [Math.abs(change) <= valor, `Variación ${change >= 0 ? '+' : ''}${change.toFixed(2)}% ≤ ${valor}%`]
  return [false, '']
}

function evalVolumen(turnover: number, valor: number, cond: string): [boolean, string] {
  if (cond === '>')       return [turnover > valor,  `Volumen $${turnover.toLocaleString('es-AR')} > $${valor.toLocaleString('es-AR')}`]
  if (cond === '<')       return [turnover < valor,  `Volumen $${turnover.toLocaleString('es-AR')} < $${valor.toLocaleString('es-AR')}`]
  if (cond === '>=')      return [turnover >= valor, `Volumen $${turnover.toLocaleString('es-AR')} ≥ $${valor.toLocaleString('es-AR')}`]
  if (cond === '<=')      return [turnover <= valor, `Volumen $${turnover.toLocaleString('es-AR')} ≤ $${valor.toLocaleString('es-AR')}`]
  return [false, '']
}

async function evalMA(sym: string, valor: number, cond: string, params: any, esUsa: boolean): Promise<[boolean, string]> {
  const table = esUsa ? 'mercado_usa_history' : 'mercado_history'
  const periodos = params?.ma_periodos || 20
  const limit = periodos + 5
  const { data } = await sb.from(table)
    .select('last')
    .eq('symbol', sym)
    .order('ts', { ascending: false })
    .limit(limit)

  if (!data || data.length < periodos) return [false, 'pocos datos']
  const prices = data.map((r: any) => Number(r.last)).filter((v: number) => !isNaN(v)).slice(0, periodos)
  if (prices.length < periodos) return [false, 'pocos datos']
  const ma = prices.reduce((a: number, b: number) => a + b, 0) / prices.length
  const cur = prices[0]

  if (cond === 'cruz_alza')  return [cur > ma && (prices[1] || 0) <= ma, `Cruzó al alza MA(${periodos}): ${fmtARS(cur)} > ${fmtARS(ma)}`]
  if (cond === 'cruz_baja')  return [cur < ma && (prices[1] || 0) >= ma, `Cruzó a la baja MA(${periodos}): ${fmtARS(cur)} < ${fmtARS(ma)}`]
  if (cond === '>')          return [cur > ma, `${fmtARS(cur)} > MA(${periodos}) ${fmtARS(ma)}`]
  if (cond === '<')          return [cur < ma, `${fmtARS(cur)} < MA(${periodos}) ${fmtARS(ma)}`]
  return [false, '']
}

function buildMsg(a: Alerta, cur: number, change: number, condDesc: string): string {
  const emoji = a.tipo === 'precio' ? '💰' : a.tipo === 'sltp' ? '🎯' : a.tipo === 'ma' ? '📊' : a.tipo === 'variacion' ? '📈' : '📉'
  const sig = change >= 0 ? '+' : ''
  return [
    `${emoji} *ALERTA — ${a.ticker}*`,
    `Tipo: ${a.tipo}`,
    `Condición: ${condDesc}`,
    `Precio: ${fmtARS(cur)} (${sig}${change.toFixed(2)}%)`,
    a.params?.nota ? `📝 ${a.params.nota}` : '',
    `🕐 ${new Date().toLocaleTimeString('es-AR')}`
  ].filter(Boolean).join('\n')
}

// ── ENVIO ──────────────────────────────────────────────
async function enviarTelegram(token: string, chatId: string, msg: string): Promise<boolean> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' })
    })
    const d = await r.json()
    return d.ok === true
  } catch {
    return false
  }
}

async function enviarWhatsApp(num: string, key: string, msg: string): Promise<boolean> {
  try {
    await fetch(`https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(num)}&text=${encodeURIComponent(msg)}&apikey=${key}`, { mode: 'no-cors' })
    return true
  } catch {
    return false
  }
}

// Tokens globales (hardcodeados desde el CFG del proyecto)
const TG_TOKEN = '8576934070:AAFrb--ocLPcFZh-mOzFDTc5ujYnouA3H3U'
const TG_CHAT_ID = '6209263987'
const WA_NUM = '+541162410971'
const WA_KEY = 'https://api.callmebot.com/whatsapp.php?phone=5491162410971&text=This+is+a+test&apikey=4061538'

async function enviar(a: Alerta, msg: string): Promise<boolean> {
  let ok = false
  const canal = getCanal(a)
  if (canal === 'wa' || canal === 'ambos') {
    ok = (await enviarWhatsApp(WA_NUM, WA_KEY, msg)) || ok
  }
  if (canal === 'tg' || canal === 'ambos') {
    ok = (await enviarTelegram(TG_TOKEN, TG_CHAT_ID, msg)) || ok
  }
  return ok
}

// Push nativo a la app FINBOARD (Expo Push API) usando los tokens de push_tokens.
// Llega con la app en foreground, background o cerrada (vía FCM).
async function enviarPush(userId: string, ticker: string, condDesc: string): Promise<void> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/push_tokens?user_id=eq.${encodeURIComponent(userId)}&select=token`, {
      headers: { apikey: SB_SERVICE_KEY, Authorization: 'Bearer ' + SB_SERVICE_KEY }
    })
    const rows = await r.json()
    const tokens: string[] = Array.isArray(rows) ? rows.map((x: any) => x.token).filter(Boolean) : []
    if (!tokens.length) return
    const messages = tokens.map(t => ({
      to: t,
      title: 'FINBOARD · ' + ticker,
      body: condDesc,
      sound: 'default',
      priority: 'high',
      channelId: 'finboard-alerts',
    }))
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(messages)
    })
  } catch (_e) { /* no romper el flujo de alertas si el push falla */ }
}

// ── EVALUACION PRINCIPAL ───────────────────────────────
async function evaluar(alertas: Alerta[], mercado: Precio[], esUsa: boolean): Promise<number> {
  let disparadas = 0
  for (const a of alertas) {
    if (!a.activa) continue
    const sym = cleanTicker(a.ticker)
    const row = mercado.find(r => cleanTicker(r.symbol) === sym)
    if (!row) continue

    const cur = Number(row.last)
    const change = Number(row.change_pct ?? row.change ?? 0)
    const turnover = Number(row.turnover ?? 0)
    if (isNaN(cur) || cur === 0) continue

    // Cooldown check
    const cd = getCooldown(a)
    if (a.last_fired && cd > 0) {
      const cooldownMs = cd * 1000
      const lastFired = new Date(a.last_fired).getTime()
      if (Date.now() - lastFired < cooldownMs) continue
    }

    let disparado = false, condDesc = ''
    const valor = getValor(a)

    const cond = getCond(a)
    if (a.tipo === 'precio') {
      // OR condition: si hay segunda condición, evaluar ambas
      const orDir = a.params?.or_dir
      const orVal = a.params?.or_valor
      if (orDir && orVal != null) {
        const dirMap2: Record<string, string> = { gt: '>', lt: '<', gte: '>=', lte: '<=', eq: '=' }
        const orCond = dirMap2[orDir] || '>'
        ;[disparado, condDesc] = evalPrecioOr(cur, valor, cond, Number(orVal), orCond)
      } else {
        ;[disparado, condDesc] = evalPrecio(cur, valor, cond)
      }
    } else if (a.tipo === 'variacion') {
      ;[disparado, condDesc] = evalVariacion(change, valor, cond)
    } else if (a.tipo === 'volumen') {
      ;[disparado, condDesc] = evalVolumen(turnover, valor, cond)
    } else if (a.tipo === 'ma') {
      ;[disparado, condDesc] = await evalMA(sym, valor, cond, a.params, esUsa)
    } else if (a.tipo === 'sltp') {
      // Alerta única SL/TP: evalúa ambos umbrales
      const sl = Number(a.params?.sl || 0)
      const tp = Number(a.params?.tp || 0)
      if (sl && cur <= sl) {
        disparado = true
        condDesc = `SL: \$${cur.toFixed(2)} ≤ \$${sl.toFixed(2)}`
      } else if (tp && cur >= tp) {
        disparado = true
        condDesc = `TP: \$${cur.toFixed(2)} ≥ \$${tp.toFixed(2)}`
      }
    }

    if (!disparado) continue

    const msg = buildMsg(a, cur, change, condDesc)

    // Desactivar optimistamente antes de enviar para evitar duplicados
    await sb.from('alertas').update({ activa: false }).eq('id', a.id)

    const enviado = await enviar(a, msg)

    // Actualizar timestamps
    await sb.from('alertas').update({
      last_fired: new Date().toISOString(),
      fired_count: (a.fired_count || 0) + 1
    }).eq('id', a.id)

    // Registrar historial
    await sb.from('alertas_historial').insert({
      user_id: a.user_id,
      alerta_id: a.id,
      ticker: sym,
      tipo: a.tipo,
      cond_desc: condDesc,
      precio: cur,
      canal: getCanal(a),
      estado: enviado ? '✅ Enviado' : '❌ Error envío',
      fired_at: new Date().toISOString()
    })

    // Push nativo a la app (además de Telegram/WhatsApp)
    await enviarPush(a.user_id, sym, condDesc)
    disparadas++
  }
  return disparadas
}

// ── FASE C: deteccion automatica de spikes de volumen en opciones_flow ──
// Dos granularidades:
//   1m: lee opciones_flow_1m (local GGAL) — threshold 500 lotes, tabla se trunca al cierre
//   5m: lee opciones_flow       — threshold 1200 lotes, rolling 5 días
// Dedup por (symbol, ts, nivel, intervalo) via UNIQUE constraint en opciones_flow_alertas.
// Defaults (fallback si flujo_alertas_config no responde). Editables desde la app FINBOARD.
const SPIKE_ENABLED_DEF:     Record<string, boolean>   = { local: true, usa: true }
const SPIKE_THRESHOLDS_DEF:  Record<string, number[]>  = { local: [1200], usa: [1200] }
const SPIKE_THRESHOLDS_1M_DEF: number[] = [500]  // solo local, tabla opciones_flow_1m

interface SpikeCfg {
  enabled: Record<string, boolean>
  thresh5m: Record<string, number[]>
  thresh1m: number[]
}

// Lee los umbrales configurables desde flujo_alertas_config (fila id=1).
async function loadSpikeConfig(): Promise<SpikeCfg> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/flujo_alertas_config?id=eq.1&select=*`, {
      headers: { apikey: SB_SERVICE_KEY, Authorization: 'Bearer ' + SB_SERVICE_KEY }
    })
    const rows = await r.json()
    const c = Array.isArray(rows) && rows[0]
    if (!c) return { enabled: SPIKE_ENABLED_DEF, thresh5m: SPIKE_THRESHOLDS_DEF, thresh1m: SPIKE_THRESHOLDS_1M_DEF }
    return {
      enabled:  { local: c.enabled_local !== false, usa: c.enabled_usa !== false },
      thresh5m: { local: [Number(c.spike_local_5m) || 1200], usa: [Number(c.spike_usa_5m) || 1200] },
      thresh1m: [Number(c.spike_local_1m) || 500],
    }
  } catch (_e) {
    return { enabled: SPIKE_ENABLED_DEF, thresh5m: SPIKE_THRESHOLDS_DEF, thresh1m: SPIKE_THRESHOLDS_1M_DEF }
  }
}

async function enviarPushTodos(ticker: string, condDesc: string): Promise<void> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/push_tokens?select=token`, {
      headers: { apikey: SB_SERVICE_KEY, Authorization: 'Bearer ' + SB_SERVICE_KEY }
    })
    const rows = await r.json()
    const tokens: string[] = Array.isArray(rows) ? rows.map((x: any) => x.token).filter(Boolean) : []
    if (!tokens.length) return
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(tokens.map(t => ({
        to: t, title: 'FINBOARD · ' + ticker, body: condDesc,
        sound: 'default', priority: 'high', channelId: 'finboard-alerts',
      })))
    })
  } catch (_e) {}
}

function artTime(): string {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date())
}

async function _detectarSpikesFromTable(
  tableName: string,
  intervalo: string,
  mercados: string[],
  thresholds: Record<string, number[]>,
  freshnessSecs: number,
  enabled: Record<string, boolean>
): Promise<number> {
  let fired = 0
  const svcHeaders = { apikey: SB_SERVICE_KEY, Authorization: 'Bearer ' + SB_SERVICE_KEY }

  for (const mercado of mercados) {
    if (!enabled[mercado]) continue
    const thresh_list = thresholds[mercado] || []
    if (!thresh_list.length) continue
    try {
      const lastR = await fetch(
        `${SB_URL}/rest/v1/${tableName}?select=ts&mercado=eq.${mercado}&order=ts.desc&limit=1`,
        { headers: svcHeaders }
      ).then(r => r.json())
      const tHoy: string | undefined = Array.isArray(lastR) && lastR[0]?.ts
      if (!tHoy) continue
      if (Date.now() - new Date(tHoy).getTime() > freshnessSecs * 1000) continue

      const prevR = await fetch(
        `${SB_URL}/rest/v1/${tableName}?select=ts&mercado=eq.${mercado}&ts=lt.${encodeURIComponent(tHoy)}&order=ts.desc&limit=1`,
        { headers: svcHeaders }
      ).then(r => r.json())
      const tPrev: string | undefined = Array.isArray(prevR) && prevR[0]?.ts
      if (!tPrev) continue

      const sel = 'select=symbol,underlying,strike,kind,last,bid,ask,volume,operations,price_underlying'
      const fetchSnap = (t: string) => fetch(
        `${SB_URL}/rest/v1/${tableName}?${sel}&mercado=eq.${mercado}&ts=eq.${encodeURIComponent(t)}&limit=10000`,
        { headers: svcHeaders }
      ).then(r => r.json())
      const [hoyRows, prevRows] = await Promise.all([fetchSnap(tHoy), fetchSnap(tPrev)])
      if (!Array.isArray(hoyRows) || !Array.isArray(prevRows)) continue

      const prevMap: Record<string, any> = {}
      for (const r of prevRows) prevMap[r.symbol] = r

      for (const h of hoyRows) {
        const p = prevMap[h.symbol]
        if (!p) continue
        const dVol = (Number(h.volume) || 0) - (Number(p.volume) || 0)
        if (dVol <= 0) continue
        const dOps = (h.operations != null && p.operations != null)
          ? (Number(h.operations) - Number(p.operations)) : null
        const underlying = h.underlying || 'GGAL'

        for (const thresh of thresh_list) {
          if (dVol < thresh) continue

          const kindLbl = String(h.kind || '').toLowerCase().startsWith('c') ? 'CALL' : 'PUT'
          const flag = mercado === 'usa' ? '🇺🇸' : '🇦🇷'
          const durLabel = intervalo === '1m' ? '~1 min' : '~5 min'
          const mid = ((Number(h.bid) || 0) + (Number(h.ask) || 0)) / 2
          const esCompra = mid > 0 && (Number(h.last) || 0) >= mid
          const ladoLbl = mid > 0 ? (esCompra ? '🟢 COMPRA' : '🔴 VENTA') : 'flujo'
          const condDesc = `Spike ${ladoLbl} (aprox): +${dVol.toLocaleString('en-US')} lotes en ${durLabel} · ${underlying} ${kindLbl} $${h.strike}`
          const emoji = thresh >= 1000 ? '🚨' : '⚠️'
          const msg = [
            `${emoji} *FLUJO OPCIONES — ${flag} ${underlying} ${mercado.toUpperCase()}*`,
            `${ladoLbl} ${kindLbl} strike $${h.strike} _(dirección aprox.)_`,
            `Volumen +${dVol.toLocaleString('en-US')} lotes en ${durLabel}`,
            dOps != null && dOps > 0 ? `Operaciones: +${dOps} (~${Math.round(dVol / dOps)} lotes/op)` : '',
            h.price_underlying ? `Subyacente: $${Number(h.price_underlying).toFixed(2)}` : '',
            `🕐 ${artTime()}`
          ].filter(Boolean).join('\n')

          try {
            const ins = await sb.from('opciones_flow_alertas').insert({
              symbol: h.symbol, ts: tHoy, mercado, dvol: dVol,
              kind: kindLbl, strike: h.strike, lado: ladoLbl,
              cond_desc: condDesc, enviado: false, nivel: thresh, intervalo
            })
            if (ins.error) continue
          } catch (_e) { continue }
          // Telegram de spikes de opciones DESHABILITADO (2026-07-05): ya llega por push
          // nativo a la app FINBOARD; evitamos acumular mensajes en Telegram. Solo push:
          void msg
          await enviarPushTodos(`${underlying} ${mercado.toUpperCase()}`, condDesc)
          fired++
        }
      }
    } catch (_e) { /* no romper el flujo principal de alertas */ }
  }
  return fired
}

async function detectarSpikesFlujo(): Promise<number> {
  const cfg = await loadSpikeConfig()
  const [spikes5m, spikes1m] = await Promise.all([
    _detectarSpikesFromTable('opciones_flow',    '5m', ['local','usa'], cfg.thresh5m,            10 * 60, cfg.enabled),
    _detectarSpikesFromTable('opciones_flow_1m', '1m', ['local'],       { local: cfg.thresh1m }, 3 * 60,  cfg.enabled),
  ])
  return spikes5m + spikes1m
}

// ── FASE D: ORDENES GRANDES paradas en punta (bid_size/ask_size de opciones_rt, GGAL local) ──
// Distinto de FASE C (spike de VOLUMEN OPERADO): esto mira el TAMAÑO DE LA ORDEN en punta, se
// ejecute o no -- pedido explícito del usuario (30-oct): "no avisarme cada compra chica, pero
// sí cuando aparece una orden grande, se ejecute o no" (ej. 5000 lotes en GFGV4400DI).
// Edge-triggered vía opciones_orden_grande_estado: solo dispara al CRUZAR el umbral hacia
// arriba (no cada ~30s mientras la orden sigue parada); vuelve a poder disparar si el tamaño
// cae debajo del umbral y sube de nuevo (otra orden, o la misma recotizada).
async function detectarOrdenesGrandes(): Promise<number> {
  const svcHeaders = { apikey: SB_SERVICE_KEY, Authorization: 'Bearer ' + SB_SERVICE_KEY }
  try {
    const cfgR = await fetch(
      `${SB_URL}/rest/v1/flujo_alertas_config?id=eq.1&select=orden_grande_umbral,orden_grande_enabled`,
      { headers: svcHeaders }
    )
    const cfgRows = await cfgR.json()
    const cfg = Array.isArray(cfgRows) && cfgRows[0]
    if (!cfg || cfg.orden_grande_enabled === false) return 0
    const umbral = Number(cfg.orden_grande_umbral) || 3000

    const bookR = await fetch(
      `${SB_URL}/rest/v1/opciones_rt?underlying_asset=eq.GGAL&select=symbol,strike,kind,expiration,bid,bid_size,ask,ask_size` +
      `&or=(bid_size.gte.${umbral},ask_size.gte.${umbral})`,
      { headers: svcHeaders }
    )
    const rows = await bookR.json()
    if (!Array.isArray(rows) || !rows.length) return 0

    const estadoR = await fetch(
      `${SB_URL}/rest/v1/opciones_orden_grande_estado?select=symbol,side,size`, { headers: svcHeaders }
    )
    const estadoRows = await estadoR.json()
    const estado: Record<string, number> = {}
    if (Array.isArray(estadoRows)) for (const e of estadoRows) estado[`${e.symbol}|${e.side}`] = Number(e.size)

    let fired = 0
    for (const r of rows) {
      const kindLbl = String(r.kind || '').toLowerCase().startsWith('c') ? 'CALL' : 'PUT'
      for (const side of ['bid', 'ask'] as const) {
        const size = Number(side === 'bid' ? r.bid_size : r.ask_size) || 0
        const key = `${r.symbol}|${side}`
        const prev = estado[key] ?? 0
        const yaGrande = prev >= umbral
        if (size !== prev) {
          await sb.from('opciones_orden_grande_estado')
            .upsert({ symbol: r.symbol, side, size, updated_at: new Date().toISOString() })
        }
        if (size < umbral || yaGrande) continue   // sigue chica, o ya estaba grande (no re-avisar)

        // cruzó el umbral hacia arriba -> disparar
        const sideLbl = side === 'bid' ? '🟢 COMPRA (bid)' : '🔴 VENTA (ask)'
        const precio = side === 'bid' ? r.bid : r.ask
        const condDesc = `${sideLbl} ${size.toLocaleString('en-US')} lotes @ $${precio} · ${kindLbl} $${r.strike}` +
          (r.expiration ? ` ${r.expiration}` : '')
        await enviarPushTodos(`GFG ${kindLbl} $${r.strike}`, condDesc)
        fired++
      }
    }
    return fired
  } catch (_e) {
    return 0
  }
}

// ── HANDLER ────────────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() })
  }

  const start = Date.now()

  try {
    if (await peerEstaSano()) {
      return new Response(JSON.stringify({ ok: true, skipped: 'peer-healthy', ms: Date.now() - start }), { headers: { ...corsHeaders(), 'Content-Type': 'application/json' } })
    }
    // FASE C: spikes automaticos de volumen en opciones_flow (independiente de alertas de usuario)
    let spikes = 0
    try { spikes = await detectarSpikesFlujo() } catch (_e) { /* no romper */ }
    // FASE D: ordenes grandes paradas en punta (bid_size/ask_size), se ejecuten o no
    let ordenesGrandes = 0
    try { ordenesGrandes = await detectarOrdenesGrandes() } catch (_e) { /* no romper */ }

    // 1. Cargar todas las alertas activas con sus configs
    const { data: alertas, error: errA } = await sb.from('alertas')
      .select('id,user_id,ticker,tipo,params,activa,last_fired,fired_count,created_at')
      .eq('activa', true)

    if (errA || !alertas?.length) {
      return new Response(JSON.stringify({ ok: true, checked: 0, spikes, ordenesGrandes, ms: Date.now() - start }), { headers: { ...corsHeaders(), 'Content-Type': 'application/json' } })
    }

    // 2. Cargar precios actuales (fetch directo con anon key que funciona)
    const anonHeaders = { 'apikey': SB_SERVICE_KEY, 'Authorization': 'Bearer ' + SB_SERVICE_KEY }
    const [arsRaw, usaRaw, optRaw] = await Promise.all([
      fetch(`${SB_URL}/rest/v1/mercado?select=symbol,last,change,turnover&settlement=eq.24hs&order=turnover.desc.nullslast&limit=2000`, { headers: anonHeaders }).then(r => r.json()),
      fetch(`${SB_URL}/rest/v1/mercado_usa?select=symbol,last,change_pct&limit=2000`, { headers: anonHeaders }).then(r => r.json()),
      fetch(`${SB_URL}/rest/v1/opciones_rt?select=symbol,last,bid&order=updated_at.desc&limit=500`, { headers: anonHeaders }).then(r => r.json())
    ])
    const preciosArsArr: Precio[] = Array.isArray(arsRaw) ? arsRaw : []
    const preciosUsaArr: Precio[] = Array.isArray(usaRaw) ? usaRaw : []
    const preciosOptArr: Precio[] = Array.isArray(optRaw) ? optRaw : []

    // 3. Clasificar alertas por mercado (sin mutar el array original)
    const alertasArs: Alerta[] = []
    const alertasUsa: Alerta[] = []
    const alertasOpc: { alerta: Alerta; precio: number }[] = []
    const sinPrecio: string[] = []

    for (const a of alertas as Alerta[]) {
      const sym = cleanTicker(a.ticker)

      // Opciones: tickers con formato alfanumérico largo (ej: GFGV5974JU)
      const esOpt = a.ticker === sym && sym.length >= 8 && /[A-Z]{4}\d/.test(sym)
      // Stop-loss / take-profit de ADRs (tipo sltp o ID termina en _sl/_tp): siempre USA
      const esSlTp = a.tipo === 'sltp' || /_(sl|tp)$/i.test(a.id)

      if (esOpt) {
        const opt = preciosOptArr.find(r => cleanTicker(r.symbol) === sym)
        if (opt) {
          const price = Number(opt.last || 0) || Number(opt.bid || 0)
          if (price) alertasOpc.push({ alerta: a, precio: price })
          else sinPrecio.push(sym)
          continue
        }
        sinPrecio.push(sym)
        continue
      }

      if (esSlTp) {
        // Buscar en USA exclusivamente
        const usa = preciosUsaArr.find(r => cleanTicker(r.symbol) === sym)
        if (usa) {
          alertasUsa.push(a)
          continue
        }
        sinPrecio.push(sym)
        continue
      }

      // Alertas standard: buscar en ARS primero, USA si no está
      const ars = preciosArsArr.find(r => cleanTicker(r.symbol) === sym)
      if (ars) {
        alertasArs.push(a)
        continue
      }
      const usa = preciosUsaArr.find(r => cleanTicker(r.symbol) === sym)
      if (usa) {
        alertasUsa.push(a)
        continue
      }
      sinPrecio.push(sym)
    }

    // 4. Evaluar por mercado
    let disparadas = 0
    if (alertasArs.length) {
      disparadas += await evaluar(alertasArs, preciosArsArr, false)
    }
    if (alertasUsa.length) {
      disparadas += await evaluar(alertasUsa, preciosUsaArr, true)
    }
    for (const { alerta, precio } of alertasOpc) {
      disparadas += await evaluar([alerta], [{ symbol: alerta.ticker, last: precio }], false)
    }

    return new Response(JSON.stringify({
      ok: true,
      alertas: alertas?.length || 0,
      disparadas,
      spikes,
      ordenesGrandes,
      ms: Date.now() - start
    }), { headers: { ...corsHeaders(), 'Content-Type': 'application/json' } })

  } catch (err: any) {
    console.error('alertas-engine error:', err)
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    })
  }
})
