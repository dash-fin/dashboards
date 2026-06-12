// yahoo-options: cadena de opciones + OI desde Yahoo Finance (crumb dance).
// Reemplaza a CBOE (que se congela en tickers ilíquidos como GGAL).
// Devuelve formato compatible: { options:[{strike,kind,open_interest,volume,last,bid,ask,iv,expiration,symbol}], spot, ticker, source, timestamp }
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

function mapOpt(o: any, kind: string) {
  let exp: string | null = null
  if (o.expiration) exp = new Date(o.expiration * 1000).toISOString().slice(0, 10)
  else {
    const m = (o.contractSymbol || '').match(/^[A-Z]+(\d{2})(\d{2})(\d{2})[CP]\d{8}$/)
    if (m) exp = `20${m[1]}-${m[2]}-${m[3]}`
  }
  return {
    symbol: o.contractSymbol,
    strike: o.strike,
    kind,
    open_interest: o.openInterest ?? 0,
    volume: o.volume ?? 0,
    last: o.lastPrice ?? null,
    bid: o.bid ?? null,
    ask: o.ask ?? null,
    iv: o.impliedVolatility ?? null,
    expiration: exp,
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'No autorizado' }, 401)
    const jwt = authHeader.replace('Bearer ', '')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const authResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': supabaseKey ?? '' },
    })
    if (!authResp.ok) return json({ error: 'Sesion invalida' }, 401)

    const body = await req.json()
    const ticker = ((body.ticker || 'SPY') + '').toUpperCase().trim()
    const maxExp = Math.min(Number(body.maxExp) || 8, 12)

    // ── Crumb dance (cookie + token anti-scraping) ──
    const r1 = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA } })
    const setCookies = (typeof (r1.headers as any).getSetCookie === 'function')
      ? (r1.headers as any).getSetCookie() : [r1.headers.get('set-cookie')].filter(Boolean)
    const cookie = (setCookies as string[]).map(c => c.split(';')[0]).join('; ')
    const yfHeaders = { 'User-Agent': UA, 'Cookie': cookie }
    const crumbResp = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: yfHeaders })
    const crumb = (await crumbResp.text()).trim()
    if (!crumb || crumb.length > 24 || crumb.includes('{')) return json({ error: 'Yahoo crumb fallo' }, 200)

    const base = `https://query2.finance.yahoo.com/v7/finance/options/${ticker}?crumb=${encodeURIComponent(crumb)}`
    const first = await fetch(base, { headers: yfHeaders })
    const fdata = await first.json()
    const res0 = fdata?.optionChain?.result?.[0]
    if (!res0) return json({ error: 'Sin datos Yahoo para ' + ticker }, 200)
    const spot = res0.quote?.regularMarketPrice ?? res0.quote?.regularMarketPreviousClose ?? null
    const expDates: number[] = res0.expirationDates || []

    const all: any[] = []
    const pushChain = (r: any) => {
      (r?.options?.[0]?.calls || []).forEach((o: any) => all.push(mapOpt(o, 'call')))
      ;(r?.options?.[0]?.puts || []).forEach((o: any) => all.push(mapOpt(o, 'put')))
    }
    pushChain(res0)

    // Resto de vencimientos en paralelo (Yahoo devuelve uno por request)
    const rest = expDates.slice(1, maxExp)
    const more = await Promise.all(rest.map((ts) =>
      fetch(`${base}&date=${ts}`, { headers: yfHeaders })
        .then((r) => r.json()).then((d) => d?.optionChain?.result?.[0]).catch(() => null)
    ))
    more.forEach((r) => { if (r) pushChain(r) })

    return json({ options: all, spot, ticker, source: 'yahoo', timestamp: new Date().toISOString() }, 200)
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
