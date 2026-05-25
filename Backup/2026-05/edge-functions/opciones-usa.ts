// ═══ source/index.ts ═══
import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const url = new URL(req.url)
  const symbol = url.searchParams.get("symbol") || "GGAL"

  try {
    // Consulta directa a Yahoo options API
    const yahooResp = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/options/${symbol}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://finance.yahoo.com/",
          "Origin": "https://finance.yahoo.com",
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(15000),
      }
    )

    if (!yahooResp.ok) {
      const errorText = await yahooResp.text()
      return new Response(
        JSON.stringify({ error: `Yahoo HTTP ${yahooResp.status}`, detail: errorText.slice(0, 500) }),
        { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      )
    }

    const data = await yahooResp.json()

    // Manejar error de Yahoo (crumb)
    if (data?.finance?.error) {
      return new Response(
        JSON.stringify({ error: "Yahoo requires auth crumb", detail: data.finance.error }),
        { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      )
    }

    const result = data?.optionChain?.result?.[0]
    if (!result) {
      return new Response(
        JSON.stringify({ error: "No option data", raw: JSON.stringify(data).slice(0, 500) }),
        { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      )
    }

    const quote = result.quote || {}
    const options = result.options?.[0] || {}

    const format = (o: any, type: string) => ({
      symbol: o.contractSymbol,
      type,
      strike: o.strike,
      expiration: options.expiration
        ? new Date(options.expiration * 1000).toISOString().split("T")[0]
        : null,
      last: o.lastPrice,
      bid: o.bid,
      ask: o.ask,
      change: o.change,
      change_pct: o.percentChange,
      volume: o.volume,
      open_interest: o.openInterest,
      implied_vol: o.impliedVolatility,
      in_the_money: o.inTheMoney,
    })

    return new Response(JSON.stringify({
      symbol,
      underlying_price: quote.regularMarketPrice,
      underlying_change: quote.regularMarketChangePercent,
      expiration: options.expiration
        ? new Date(options.expiration * 1000).toISOString().split("T")[0]
        : null,
      calls: (options.calls || []).map((o: any) => format(o, "call")),
      puts: (options.puts || []).map((o: any) => format(o, "put")),
    }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    )
  }
})
