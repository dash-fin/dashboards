// ══════════════════════════════════════════════════════════════════
// Supabase Edge Function: yahoo-prices
// Proxy para Yahoo Finance con autenticación crumb automática
// + Histórico local ARS vía Rava Bursátil
//
// Modo 1 — precios actuales:
//   POST { symbols: ["DOCU", "JD", "OKLO"] }
//   Response: [{ symbol, last, change_pct }]
//
// Modo 2 — cierres históricos locales:
//   POST { mode: "rava-history", symbols: ["AL30", "PG"], dates: ["2024-12-31", "2026-04-04"] }
//   Response: { "AL30": { "2024-12-31": 52000, "2026-04-04": 61500 }, ... }
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
//
// URL:    https://admin.rava.com/api/v3/publico/cotizaciones/historicos
// Method: POST, Content-Type: application/x-www-form-urlencoded
// Params: access_token, especie (ticker BYMA), desde (YYYY-MM-DD), hasta (YYYY-MM-DD)
// Token:  fedd65202420d32e4c00e6d4fcd525e3  (api_public_key público de Rava)
//
// Response: JSON con array en body|data|historicos|cotizaciones o raíz del objeto
// Cada fila: { fecha: "YYYY-MM-DD", apertura, maximo, minimo, ultimo, cierre, volumen, timestamp }
//
// Nota: la API ignora el rango de fechas y devuelve ~225 filas (~1 año de datos diarios).
// Se puede usar para bonos (AL30, AL30D, GD30, etc.) y CEDEARs listados en BYMA.
// El MEP diario (AL30.cierre / AL30D.cierre) ya está en la tabla mep_historico de Supabase.
// Solo se necesita Rava si se quieren series de precios ARS de otros instrumentos.
//
const RAVA_TOKEN = "fedd65202420d32e4c00e6d4fcd525e3"; // api_public_key de Rava

// Alias para tickers cuyo especie en Rava difiere del ticker usado en el dashboard
const RAVA_ALIAS: Record<string, string> = {};

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
    const data = await resp.json();
    const rows: Array<{fecha: string; cierre: number}> =
      Array.isArray(data)               ? data :
      Array.isArray(data?.body)         ? data.body :
      Array.isArray(data?.data)         ? data.data :
      Array.isArray(data?.historicos)   ? data.historicos :
      Array.isArray(data?.cotizaciones) ? data.cotizaciones :
      [];
    return rows.filter(r => r.fecha && r.cierre > 0);
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
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json() as { symbols?: string[]; mode?: string; dates?: string[] };
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

    // ── Modo 1: precios actuales vía Yahoo ──────────────────
    if (!symbols?.length) throw new Error("symbols requerido");

    const { crumb, cookie } = await getYahooCrumb();
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(",")}&crumb=${encodeURIComponent(crumb)}&fields=regularMarketPrice,regularMarketChangePercent,beta`;

    const resp = await fetch(url, {
      headers: { "User-Agent": UA, "Cookie": cookie },
    });
    if (!resp.ok) throw new Error(`Yahoo HTTP ${resp.status}`);

    const data = await resp.json();
    const result = (data?.quoteResponse?.result ?? []).map((q: any) => ({
      symbol:     q.symbol,
      last:       q.regularMarketPrice          ?? null,
      change_pct: q.regularMarketChangePercent  ?? null,
      beta:       q.beta                        ?? null,
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
