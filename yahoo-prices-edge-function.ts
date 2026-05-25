// ══════════════════════════════════════════════════════════════════
// Supabase Edge Function: yahoo-prices
// Proxy para Yahoo Finance con autenticación crumb automática
// + Histórico local ARS vía Rava Bursátil
// + Opciones vía Yahoo Finance
//
// Modo 1 — precios actuales:
//   POST { symbols: ["DOCU", "JD", "OKLO"] }
//   Response: [{ symbol, last, change_pct }]
//
// Modo 2 — cierres históricos locales:
//   POST { mode: "rava-history", symbols: ["AL30", "PG"], dates: ["2024-12-31", "2026-04-04"] }
//   Response: { "AL30": { "2024-12-31": 52000, "2026-04-04": 61500 }, ... }
//
// Modo 3 — serie completa vía Rava:
//   POST { mode: "rava-series", symbols: ["GGAL","AL30"] }
//
// Modo 4 — opciones Yahoo:
//   POST { mode: "yfinance-options", symbols: ["GGAL"], action: "expirations" }
//   POST { mode: "yfinance-options", symbols: ["GGAL"], action: "chain", expiration: "2026-06-18" }
//
// Modo 5 — histórico de precios Yahoo:
//   POST { mode: "price-history", symbols: ["GGAL"], period: "1mo", interval: "1d" }
// ══════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── Yahoo crumb ───────────────────────────────────────────────────
async function getYahooCrumb(): Promise<{ crumb: string; cookie: string }> {
  const cookieResp = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  const setCookie = cookieResp.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(",")
    .map(c => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

  const crumbResp = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, "Cookie": cookie },
  });
  const crumb = await crumbResp.text();
  if (!crumb || crumb.includes("{")) throw new Error("No se pudo obtener crumb de Yahoo");
  return { crumb, cookie };
}

// ── Rava histórico (API interna admin.rava.com) ───────────────────
// Devuelve ~225 filas con toda la historia disponible (1 año aprox.)
// La API ignora el rango de fechas, se filtra acá.
const RAVA_TOKEN = "fedd65202420d32e4c00e6d4fcd525e3"; // api_public_key de Rava

// Tickers que Rava identifica con especie compuesta (CT = contado 24hs)
const RAVA_ALIAS: Record<string, string> = {
  "AL30D": "AL30D-0002-C-CT-USD", // AL30 en dólares → para calcular MEP histórico
  "GD30D": "GD30D-0002-C-CT-USD",
};

async function fetchRavaHistory(sym: string): Promise<Array<{fecha: string; cierre: number}>> {
  const especie = RAVA_ALIAS[sym] ?? sym;
  try {
    const body = new URLSearchParams({
      access_token: RAVA_TOKEN,
      especie,
      desde: "2024-01-01",
      hasta: new Date().toISOString().split("T")[0],
    });
    const resp = await fetch("https://admin.rava.com/api/v3/publico/cotizaciones/historicos", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
        "Referer": "https://www.rava.com/",
      },
      body: body.toString(),
    });
    if (!resp.ok) return [];
    const data = await resp.json() as { body?: Array<{fecha: string; cierre: number}> };
    return (data?.body ?? []).filter(r => r.fecha && r.cierre > 0);
  } catch {
    return [];
  }
}

// Dado un historial, retorna el cierre del día hábil más reciente <= refDate
function closestClose(history: Array<{fecha: string; cierre: number}>, refDate: string): number | null {
  const rows = history.filter(r => r.fecha <= refDate).sort((a, b) => b.fecha.localeCompare(a.fecha));
  return rows[0]?.cierre ?? null;
}

// ── Handler principal ─────────────────────────────────────────────
interface AnyBody { symbols?: string[]; mode?: string; dates?: string[]; action?: string; expiration?: string; period?: string; interval?: string; }

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json() as AnyBody;
    const { symbols, mode, dates } = body;

    // ── Modo 2: histórico local vía Rava ────────────────────
    if (mode === "rava-history") {
      if (!symbols?.length || !dates?.length) throw new Error("symbols y dates requeridos");

      const result: Record<string, Record<string, number | null>> = {};

      // Traer el historial de cada símbolo (una sola llamada por símbolo) y filtrar por fecha
      await Promise.all(symbols.map(async (sym) => {
        result[sym] = {};
        const history = await fetchRavaHistory(sym);
        for (const date of dates) {
          result[sym][date] = closestClose(history, date);
        }
      }));

      return new Response(JSON.stringify(result), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── Modo 3: serie completa vía Rava (para gráficos YTD) ─
    if (mode === "rava-series") {
      if (!symbols?.length) throw new Error("symbols requerido");
      const result: Record<string, Array<{fecha: string; cierre: number}>> = {};
      await Promise.all(symbols.map(async (sym) => {
        result[sym] = await fetchRavaHistory(sym);
      }));
      return new Response(JSON.stringify(result), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── Modo 4: opciones vía Yahoo ────────────────────────
    if (mode === "yfinance-options") {
      if (!symbols?.length) throw new Error("symbols requerido");
      const sym = symbols[0];
      const action = (body as any).action || "expirations";

      if (action === "expirations") {
        // Usar v7/options para obtener vencimientos disponibles
        const { crumb, cookie } = await getYahooCrumb();
        const url = `https://query1.finance.yahoo.com/v7/finance/options/${sym}?crumb=${encodeURIComponent(crumb)}`;
        const resp = await fetch(url, {
          headers: { "User-Agent": UA, "Cookie": cookie },
        });
        if (!resp.ok) throw new Error(`Yahoo HTTP ${resp.status}`);
        const data = await resp.json();
        const result = data?.optionChain?.result?.[0];
        if (!result) throw new Error("Sin datos de opciones");

        const exps: string[] = (result.expirationDates || []).map((ts: number) => {
          const d = new Date(ts * 1000);
          return d.toISOString().split("T")[0];
        }).filter(Boolean);

        const spotPrice = result.quote?.regularMarketPrice || null;

        return new Response(JSON.stringify({ [sym]: { expirations: exps, spot: spotPrice } }), {
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      if (action === "chain") {
        const expiration = (body as any).expiration;
        if (!expiration) throw new Error("expiration requerido para chain");
        const timestamp = Math.floor(new Date(expiration + "T12:00:00").getTime() / 1000);

        const { crumb, cookie } = await getYahooCrumb();
        const url = `https://query1.finance.yahoo.com/v7/finance/options/${sym}?date=${timestamp}&formatted=true&lang=en-US&region=US&crumb=${encodeURIComponent(crumb)}`;
        const resp = await fetch(url, {
          headers: { "User-Agent": UA, "Cookie": cookie },
        });
        if (!resp.ok) throw new Error(`Yahoo HTTP ${resp.status}`);
        const data = await resp.json();
        const result = data?.optionChain?.result?.[0];
        if (!result?.options?.length) {
          // Return debug info
          return new Response(JSON.stringify({
            [sym]: { calls: [], puts: [], spot: result?.quote?.regularMarketPrice || null, _debug: { hasResult: !!result, options: result?.options?.length || 0, firstKey: Object.keys(data?.optionChain?.result?.[0] || {})[0] || 'none' } }
          }), {
            headers: { ...CORS, "Content-Type": "application/json" },
          });
        }

        const calls = result.options[0].calls || [];
        const puts  = result.options[0].puts  || [];

        const extractChain = (items: any[]) => items.map((o: any) => ({
          strike:            o.strike,
          openInterest:      o.openInterest || 0,
          volume:            o.volume || 0,
          lastPrice:         o.lastPrice || 0,
          bid:               o.bid || 0,
          ask:               o.ask || 0,
          impliedVolatility: o.impliedVolatility || 0,
          gamma:             o.gamma || 0,
          delta:             o.delta || 0,
          theta:             o.theta || 0,
          vega:              o.vega || 0,
        }));

        return new Response(JSON.stringify({
          [sym]: {
            calls: extractChain(calls),
            puts:  extractChain(puts),
            spot:  result.quote?.regularMarketPrice || null,
          }
        }), {
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      throw new Error("Acción desconocida: " + action);
    }

    // ── Modo 5: histórico de precios vía Yahoo ────────────
    if (mode === "price-history") {
      if (!symbols?.length) throw new Error("symbols requerido");
      const period = (body as any).period || "1mo";
      const interval = (body as any).interval || "1d";

      const result: Record<string, any[]> = {};

      await Promise.all(symbols.map(async (sym) => {
        try {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${Math.floor(Date.now()/1000 - 90*86400)}&period2=${Math.floor(Date.now()/1000)}&interval=${interval}&includePrePost=false`;
          const resp = await fetch(url, {
            headers: { "User-Agent": UA },
          });
          if (!resp.ok) return;
          const data = await resp.json();
          const chart = data?.chart?.result?.[0];
          if (!chart) return;

          const timestamps = chart.timestamp || [];
          const quotes = chart.indicators?.quote?.[0] || {};
          const opens   = quotes.open   || [];
          const highs   = quotes.high   || [];
          const lows    = quotes.low    || [];
          const closes  = quotes.close  || [];

          result[sym] = timestamps.map((ts: number, i: number) => ({
            date: new Date(ts * 1000).toISOString().split("T")[0],
            open:  opens[i]  ?? null,
            high:  highs[i]  ?? null,
            low:   lows[i]   ?? null,
            close: closes[i] ?? null,
          })).filter((r: any) => r.close > 0);
        } catch (_) { /* skip */ }
      }));

      return new Response(JSON.stringify(result), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── Modo 1: precios actuales vía Yahoo ──────────────────
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
