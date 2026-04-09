// ══════════════════════════════════════════════════════════════════
// Supabase Edge Function: yahoo-prices
// Proxy genérico para Yahoo Finance — resuelve CORS desde el browser
//
// Deploy: Supabase Dashboard → Edge Functions → New Function → pegar esto
// URL resultante: https://<proyecto>.supabase.co/functions/v1/yahoo-prices
//
// Request: POST { symbols: ["DOCU", "JD", "OKLO"] }
// Response: [{ symbol, last, change_pct }]
// ══════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { symbols } = await req.json() as { symbols: string[] };
    if (!symbols?.length) throw new Error("symbols requerido");

    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(",")}&fields=regularMarketPrice,regularMarketChangePercent`;

    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!resp.ok) throw new Error(`Yahoo HTTP ${resp.status}`);

    const data = await resp.json();
    const result = (data?.quoteResponse?.result ?? []).map((q: any) => ({
      symbol:     q.symbol,
      last:       q.regularMarketPrice       ?? null,
      change_pct: q.regularMarketChangePercent ?? null,
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
