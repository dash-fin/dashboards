// ══════════════════════════════════════════════════════════════════
// Supabase Edge Function: alertas-engine
// Cron: evalua alertas cada ~30s contra precios de mercado/usa/opciones
// Envía notificaciones por Telegram / WhatsApp cuando se disparan
// ══════════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SB_URL = Deno.env.get('SUPABASE_URL')!
const SB_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const sb = createClient(SB_URL, SB_SERVICE_KEY)

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
  const dirMap: Record<string, string> = { gt: '>', lt: '<', gte: '>=', lte: '<=', eq: '=' }
  return dirMap[a.params?.dir] || '>'
}
function getValor(a: Alerta): number {
  return Number(a.params?.valor ?? a.params?.val ?? 0)
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
  const emoji = a.tipo === 'precio' ? '💰' : a.tipo === 'ma' ? '📊' : a.tipo === 'variacion' ? '📈' : '📉'
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

// ── EVALUACION PRINCIPAL ───────────────────────────────
async function evaluar(alertas: Alerta[], mercado: Precio[], esUsa: boolean): Promise<number> {
  let disparadas = 0
  for (const a of alertas) {
    if (!a.activa) continue
    const sym = cleanTicker(a.ticker)
    const row = mercado.find(r => cleanTicker(r.symbol) === sym)
    if (!row) continue

    const cur = esUsa ? Number(row.last) : Number(row.last)
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
      [disparado, condDesc] = evalPrecio(cur, valor, cond)
    } else if (a.tipo === 'variacion') {
      [disparado, condDesc] = evalVariacion(change, valor, cond)
    } else if (a.tipo === 'volumen') {
      [disparado, condDesc] = evalVolumen(turnover, valor, cond)
    } else if (a.tipo === 'ma') {
      [disparado, condDesc] = await evalMA(sym, valor, cond, a.params, esUsa)
    }

    if (!disparado) continue
    disparadas++

    const msg = buildMsg(a, cur, change, condDesc)
    const enviado = await enviar(a, msg)

    // Actualizar alerta
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
    disparadas++
  }
  return disparadas
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
    // 1. Cargar todas las alertas activas con sus configs
    const { data: alertas, error: errA } = await sb.from('alertas')
      .select('id,user_id,ticker,tipo,params,activa,last_fired,fired_count,created_at')
      .eq('activa', true)

    if (errA || !alertas?.length) {
      return new Response(JSON.stringify({ ok: true, checked: 0, ms: Date.now() - start }), { headers: { ...corsHeaders(), 'Content-Type': 'application/json' } })
    }

    // 2. Cargar precios actuales
    const [mercadoArs, mercadoUsa, opciones] = await Promise.all([
      sb.from('mercado').select('symbol,last,change,change_pct,turnover').eq('settlement', '24hs'),
      sb.from('mercado_usa').select('symbol,last,change_pct'),
      sb.from('opciones_rt').select('symbol,last,bid').order('updated_at', { ascending: false }).limit(500)
    ])

    const preciosArs = (mercadoArs.data || []) as Precio[]
    const preciosUsa = (mercadoUsa.data || []) as Precio[]
    const preciosOpt = (opciones.data || []) as Precio[]

    // 3. Clasificar alertas por mercado (sin mutar el array original)
    const alertasArs: Alerta[] = []
    const alertasUsa: Alerta[] = []
    const alertasOpc: { alerta: Alerta; precio: number }[] = []
    const sinPrecio: string[] = []

    for (const a of alertas as Alerta[]) {
      const sym = cleanTicker(a.ticker)
      const ars = preciosArs.find(r => cleanTicker(r.symbol) === sym)
      if (ars) {
        alertasArs.push(a)
        continue
      }
      const usa = preciosUsa.find(r => cleanTicker(r.symbol) === sym)
      if (usa) {
        alertasUsa.push({ ...usa, change_pct: usa.change_pct ?? usa.change ?? 0 } as Precio)
        continue
      }
      const opt = preciosOpt.find(r => cleanTicker(r.symbol) === sym)
      if (opt) {
        const price = Number(opt.last || 0) || Number(opt.bid || 0)
        if (price) alertasOpc.push({ alerta: a, precio: price })
        continue
      }
      sinPrecio.push(sym)
    }

    if (sinPrecio.length) {
      console.log(`Sin precio para: ${sinPrecio.join(', ')}`)
    }

    // 4. Evaluar por mercado
    let disparadas = 0
    if (alertasArs.length) {
      disparadas += await evaluar(alertasArs, preciosArs, false)
    }
    if (alertasUsa.length) {
      disparadas += await evaluar(alertasUsa, preciosUsa, true)
    }
    for (const { alerta, precio } of alertasOpc) {
      disparadas += await evaluar([alerta], [{ symbol: alerta.ticker, last: precio }], false)
    }

    return new Response(JSON.stringify({
      ok: true,
      alertas: alertas?.length || 0,
      disparadas,
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
