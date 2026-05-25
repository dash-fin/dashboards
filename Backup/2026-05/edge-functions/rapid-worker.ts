// ═══ source/Index.ts ═══
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response(JSON.stringify({ error: 'No autorizado' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    const jwt = authHeader.replace('Bearer ', '')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const authResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': supabaseKey }
    })
    if (!authResp.ok) return new Response(JSON.stringify({ error: 'Sesion invalida' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    const body = await req.json()

    // ── Modo CBOE options chain ──
    if (body.mode === 'cboe') {
      const ticker = body.ticker || 'SPY'
      const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${ticker}.json`
      console.log('Fetching CBOE:', url)
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      })
      console.log('CBOE status:', r.status)
      if (!r.ok) {
        return new Response(JSON.stringify({ error: 'CBOE ' + r.status }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }
      const data = await r.json()
      // Devolver solo los campos necesarios para GEX para reducir payload
      // Parsear strike y expiration desde el simbolo OCC: SPY260401C00500000
      // Formato: UNDERLYING + YYMMDD + C/P + strike*1000 (8 digitos)
      const parseOCC = (sym: string) => {
        const m = sym.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/)
        if (!m) return { strike: null, expiration: null, kind: null }
        const [, , yy, mm, dd, cp, strikeRaw] = m
        return {
          strike:     parseInt(strikeRaw) / 1000,
          expiration: `20${yy}-${mm}-${dd}`,
          kind:       cp === 'C' ? 'call' : 'put',
        }
      }

      const options = (data.data?.options || []).map((o: any) => {
        const { strike, expiration, kind } = parseOCC(o.option || '')
        return {
          symbol:        o.option,
          expiration,
          strike,
          kind,
          open_interest: o.open_interest,
          iv:            o.iv,
          delta:         o.delta,
          gamma:         o.gamma,
          theta:         o.theta,
          vega:          o.vega,
          bid:           o.bid,
          ask:           o.ask,
          last:          o.last,
          volume:        o.volume,
        }
      })
      const spot = data.data?.current_price || data.data?.close
      console.log(`CBOE ${ticker}: ${options.length} opciones, spot $${spot}`)
      return new Response(JSON.stringify({ options, spot, ticker }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ── Modo historial via Yahoo Finance ──
    if (body.mode === 'history') {
      const ticker = body.ticker
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=25y`
      console.log('Fetching Yahoo:', url)

      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      })
      console.log('Yahoo status:', r.status)

      if (!r.ok) {
        const txt = await r.text()
        console.log('Yahoo error:', txt.slice(0, 200))
        return new Response(JSON.stringify({ error: 'Yahoo ' + r.status }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }

      const raw = await r.json()
      const result = raw?.chart?.result?.[0]
      if (!result) {
        return new Response(JSON.stringify({ error: 'Sin datos Yahoo', bars: [] }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }

      // Convertir formato Yahoo a formato {t, o, h, l, c, v}
      const timestamps = result.timestamp || []
      const q = result.indicators?.quote?.[0] || {}
      const bars = timestamps.map((ts, i) => ({
        t: new Date(ts * 1000).toISOString().split('T')[0],
        o: q.open?.[i]  ?? null,
        h: q.high?.[i]  ?? null,
        l: q.low?.[i]   ?? null,
        c: q.close?.[i] ?? null,
        v: q.volume?.[i]?? null,
      })).filter(b => b.c !== null)

      console.log('Bars count:', bars.length, 'desde:', bars[0]?.t)
      return new Response(JSON.stringify({ bars: { [ticker]: bars } }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ── Modo chat ──
    const { messages, system } = body
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: system ?? 'Sos un asistente financiero.',
        messages,
      }),
    })
    const data = await resp.json()
    return new Response(JSON.stringify(data),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})