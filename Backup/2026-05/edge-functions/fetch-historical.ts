// ═══ fetch-historical/index.ts ═══
// ══════════════════════════════════════════════════════════════════
// Supabase Edge Function: fetch-historical
// Trae datos históricos de precios de cierre on-demand desde Yahoo Finance
// + cache local en price_cache
//
// Proxy de yahoo-history para cuando se necesita un rango específico
// que no está en historico_precios (datos pre-2025-05-15)
//
// POST { symbols: ["AAPL","GGAL"], from: "2024-01-01", to: "2025-05-14", persist: true }
//   → { "AAPL": [{fecha, close}], "GGAL": [...] }
//
// Si los datos están en price_cache, los sirve de ahí sin pegarle a Yahoo.
// Con persist:true también upsertea a historico_precios (PK: symbol+fecha).
// ══════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// ── Yahoo crumb ───────────────────────────────────────────────────
let _crumb: { value: string; cookie: string; expires: number } | null = null;

async function getYahooCrumb(): Promise<{ crumb: string; cookie: string }> {
  if (_crumb && Date.now() < _crumb.expires) {
    return { crumb: _crumb.value, cookie: _crumb.cookie };
  }
  const r1 = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  const cookie = r1.headers.get("set-cookie") ?? "";
  const r2 = await fetch(
    "https://query2.finance.yahoo.com/v1/test/getcrumb",
    { headers: { "User-Agent": UA, Cookie: cookie } }
  );
  const crumb = (await r2.text()).trim();
  _crumb = { value: crumb, cookie, expires: Date.now() + 3_600_000 };
  return { crumb, cookie };
}

// ── Fetch histórico Yahoo ────────────────────────────────────────
async function fetchYahooHistory(
  symbol: string, from: string, to: string
): Promise<{ fecha: string; close: number }[]> {
  const { crumb, cookie } = await getYahooCrumb();
  const period1 = Math.floor(new Date(from).getTime() / 1000);
  const period2 = Math.floor(new Date(to + "T23:59:59").getTime() / 1000);
  const url =
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${period1}&period2=${period2}&interval=1d&events=history`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, Cookie: cookie, "X-Yahoo-Client-App": "finance" },
  });
  if (!resp.ok) return [];
  const json = await resp.json();
  const result = json?.chart?.result?.[0];
  if (!result) return [];
  const timestamps: number[] = result.timestamp ?? [];
  const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
  const data: { fecha: string; close: number }[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] != null) {
      const d = new Date(timestamps[i] * 1000);
      const fecha = d.toISOString().slice(0, 10);
      data.push({ fecha, close: closes[i]! });
    }
  }
  return data;
}

// ── Servicio ─────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { symbols, from, to, persist } = await req.json();
    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
      return new Response(JSON.stringify({ error: "symbols[] requerido" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const lookupFrom = from || "2024-01-01";
    const lookupTo = to || new Date().toISOString().slice(0, 10);

    // Intentar cache primero
    const sbKey = req.headers.get("apikey") || "";
    const sb = createClient(
      "https://endymbpdayeidromxayb.supabase.co",
      sbKey
    );

    const result: Record<string, { fecha: string; close: number }[]> = {};
    const toFetch: string[] = [];

    for (const sym of symbols) {
      const { data: cached } = await sb
        .from("price_cache")
        .select("data, desde, hasta")
        .eq("ticker", sym)
        .single();

      if (cached && cached.desde <= lookupFrom && cached.hasta >= lookupTo) {
        const raw = typeof cached.data === "string"
          ? JSON.parse(cached.data)
          : cached.data;
        result[sym] = (raw as any[]).map((d: any) => ({
          fecha: d.fecha,
          close: d.close,
        }));
      } else {
        toFetch.push(sym);
      }
    }

    // Fetch de los que no están en cache
    if (toFetch.length > 0) {
      const fetches = toFetch.map((sym) =>
        fetchYahooHistory(sym, lookupFrom, lookupTo)
      );
      const results = await Promise.all(fetches);

      for (let i = 0; i < toFetch.length; i++) {
        const sym = toFetch[i];
        const data = results[i];
        result[sym] = data;

        // Guardar en cache (sin await para no demorar response)
        if (data.length > 0) {
          sb.from("price_cache").upsert(
            {
              ticker: sym,
              desde: lookupFrom,
              hasta: lookupTo,
              data: JSON.stringify(data),
              expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
            },
            { onConflict: "ticker" }
          ).then(() => {}).catch(() => {});
        }
      }
    }

    // Persistir a historico_precios si fue solicitado (PK: symbol+fecha)
    let persistInfo: any = null;
    if (persist) {
      // Service role para bypass RLS en upserts
      const srKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      const sbSR = createClient('https://endymbpdayeidromxayb.supabase.co', srKey);
      const rows: { symbol: string; fecha: string; close: number }[] = [];
      for (const sym of symbols) {
        const arr = result[sym] || [];
        for (const r of arr) rows.push({ symbol: sym, fecha: r.fecha, close: r.close });
      }
      const CHUNK = 1000;
      let inserted = 0;
      const errs: string[] = [];
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { error } = await sbSR.from('historico_precios').upsert(
          rows.slice(i, i + CHUNK),
          { onConflict: 'symbol,fecha' }
        );
        if (error) errs.push(error.message); else inserted += Math.min(CHUNK, rows.length - i);
      }
      persistInfo = { total: rows.length, inserted, errors: errs };
    }

    // FILTRAR POR RANGO EXACTO: las APIs de Yahoo devuelven más datos del rango
    for (const sym of symbols) {
      if (result[sym] && result[sym].length > 0) {
        result[sym] = result[sym].filter(
          (r) => r.fecha >= lookupFrom && r.fecha <= lookupTo
        );
      }
    }

    const responseBody: any = result;
    if (persistInfo) responseBody._persist = persistInfo;
    return new Response(JSON.stringify(responseBody), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
