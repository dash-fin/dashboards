// ══════════════════════════════════════════════════════════════════
// Supabase Edge Function: yahoo-prices
// Proxy para Yahoo Finance con autenticación crumb automática
//
// Request: POST { symbols: ["DOCU", "JD", "OKLO"] }
// Response: [{ symbol, last, change_pct }]
// ══════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function getYahooCrumb(): Promise<{ crumb: string; cookie: string }> {
  // Paso 1: obtener cookies de Yahoo
  const cookieResp = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  const setCookie = cookieResp.headers.get("set-cookie") ?? "";
  // Extraer solo nombre=valor de cada cookie
  const cookie = setCookie.split(",")
    .map(c => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

  // Paso 2: obtener crumb
  const crumbResp = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, "Cookie": cookie },
  });
  const crumb = await crumbResp.text();
  if (!crumb || crumb.includes("{")) throw new Error("No se pudo obtener crumb de Yahoo");
  return { crumb, cookie };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { symbols } = await req.json() as { symbols: string[] };
    if (!symbols?.length) throw new Error("symbols requerido");

    const { crumb, cookie } = await getYahooCrumb();

    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(",")}&crumb=${encodeURIComponent(crumb)}&fields=regularMarketPrice,regularMarketChangePercent`;

    const resp = await fetch(url, {
      headers: { "User-Agent": UA, "Cookie": cookie },
    });
    if (!resp.ok) throw new Error(`Yahoo HTTP ${resp.status}`);

    const data = await resp.json();
    const result = (data?.quoteResponse?.result ?? []).map((q: any) => ({
      symbol:     q.symbol,
      last:       q.regularMarketPrice          ?? null,
      change_pct: q.regularMarketChangePercent  ?? null,
    }));

    return new Response(JSON.stringify(result), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
