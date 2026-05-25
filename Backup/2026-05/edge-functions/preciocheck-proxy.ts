// ═══ source/index.ts ═══
import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
}

const ALLOWED_DOMAINS = [
  "d3e6htiiul5ek9.cloudfront.net",
  "d735s5r2zljbo.cloudfront.net",
]

const PRIMARY_API = "https://d3e6htiiul5ek9.cloudfront.net/prod"
const FALLBACK_API = "https://d735s5r2zljbo.cloudfront.net/prod"

async function doFetch(targetUrl: string) {
  const res = await fetch(targetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "es-AR,es;q=0.9",
      "Referer": "https://www.preciosclaros.gob.ar/",
      "Origin": "https://www.preciosclaros.gob.ar",
    },
    signal: AbortSignal.timeout(12000),
  })
  const body = await res.text()
  return { status: res.status, body }
}

async function fetchWithFallback(targetUrl: string) {
  const urlPrimary = targetUrl.replace(PRIMARY_API, PRIMARY_API)
  try {
    const result = await doFetch(urlPrimary)
    if (result.status >= 200 && result.status < 300) return result
    console.warn(`Primary returned ${result.status}, trying fallback...`)
  } catch (e) {
    console.warn(`Primary failed: ${e.message}, trying fallback...`)
  }

  const urlFallback = targetUrl.replace(PRIMARY_API, FALLBACK_API)
  const result = await doFetch(urlFallback)
  if (result.status >= 200 && result.status < 300) return result
  throw new Error(`Fallback returned ${result.status}: ${result.body.slice(0, 200)}`)
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const url = new URL(req.url)
  const targetUrl = url.searchParams.get("url")

  if (!targetUrl) {
    return new Response(
      JSON.stringify({ error: "Falta el par\u00e1metro url" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    )
  }

  const isAllowed = ALLOWED_DOMAINS.some((d) => targetUrl.includes(d))
  if (!isAllowed) {
    return new Response(
      JSON.stringify({ error: "URL no permitida" }),
      { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    )
  }

  try {
    const result = await fetchWithFallback(targetUrl)
    return new Response(result.body, {
      status: result.status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
        "Cache-Control": "max-age=300",
      },
    })
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "Error al consultar API", detail: (e as Error).message }),
      { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    )
  }
})