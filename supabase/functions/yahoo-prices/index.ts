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
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

    // ── Modo 4: earnings dates vía Yahoo ────────────────────
    // Devuelve próxima fecha de earnings por símbolo para alertas Telegram
    if (mode === "earnings") {
      if (!symbols?.length) throw new Error("symbols requerido");
      const { crumb, cookie } = await getYahooCrumb();
      const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(",")}&crumb=${encodeURIComponent(crumb)}&fields=earningsTimestamp,earningsTimestampStart,earningsTimestampEnd`;
      const resp = await fetch(url, { headers: { "User-Agent": UA, "Cookie": cookie } });
      if (!resp.ok) throw new Error(`Yahoo HTTP ${resp.status}`);
      const data = await resp.json();
      const toDate = (ts: number | null) => ts ? new Date(ts * 1000).toISOString().split("T")[0] : null;
      const result = (data?.quoteResponse?.result ?? []).map((q: any) => ({
        symbol:       q.symbol,
        earningsDate: toDate(q.earningsTimestamp),
        dateStart:    toDate(q.earningsTimestampStart),
        dateEnd:      toDate(q.earningsTimestampEnd),
      }));
      return new Response(JSON.stringify(result), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── Modo 5: Short Volume via Nasdaq Data Link ────────────
    // POST { mode: "short-volume", symbols: ["GGAL","AAPL","ASTS"] }
    // Usa dataset NSS (Nasdaq Short Sale), cubre NYSE/Nasdaq/ARCA
    // Fallback a FINRA OTC si Nasdaq no tiene datos
    // Devuelve { "GGAL": [{ fecha, total_vol, short_vol, short_pct }], ... }
    if (mode === "short-volume") {
      if (!symbols?.length) throw new Error("symbols requerido");

      const NASDAQ_API_KEY = Deno.env.get("NASDAQ_API_KEY") || "TxAfzSQx9Fp81ysgex92";

      const result: Record<string, Array<{fecha: string; total_vol: number; short_vol: number; short_pct: number}>> = {};

      await Promise.all(symbols.map(async (sym) => {
        try {
          // Intentar Nasdaq Data Link primero (NYSE/Nasdaq/ARCA/ETS/ADRs)
          const url = `https://data.nasdaq.com/api/v3/datasets/NSS/${sym}.json?api_key=${NASDAQ_API_KEY}&rows=500&order=desc`;
          const ndlResp = await fetch(url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              "Accept": "application/json",
              "Referer": "https://data.nasdaq.com/",
            },
          });

          if (ndlResp.ok) {
            const ndlData = await ndlResp.json();
            const dataset = ndlData?.dataset;
            if (dataset?.data?.length) {
              // Columnas típicas de NSS: Date, Short Volume, Total Volume, Market
              const colIdx: Record<string, number> = {};
              const cols = dataset.column_names || [];
              cols.forEach((c: string, i: number) => { colIdx[c.toLowerCase()] = i; });

              const rows = dataset.data
                .filter((row: any[]) => {
                  const tvIdx = colIdx["total volume"] ?? colIdx["totalvolume"] ?? -1;
                  const tv = Number(row[tvIdx] || 0);
                  return tv > 0;
                })
                .map((row: any[]) => {
                  const dtIdx = colIdx["date"] ?? 0;
                  const tvIdx = colIdx["total volume"] ?? colIdx["totalvolume"] ?? -1;
                  const svIdx = colIdx["short volume"] ?? colIdx["shortvolume"] ?? -1;
                  const tv = Number(row[tvIdx] || 0);
                  const sv = Number(row[svIdx] || 0);
                  return {
                    fecha: (row[dtIdx] || "").toString().split("T")[0],
                    total_vol: Math.round(tv),
                    short_vol: Math.round(sv),
                    short_pct: tv > 0 ? Math.round(sv / tv * 1000) / 10 : 0,
                  };
                });

              result[sym] = rows;
              return;
            }
          }
        } catch {
          // Nasdaq falló, probar FINRA OTC
        }

        // Fallback: FINRA OTC
        try {
          const resp = await fetch("https://api.finra.org/data/group/OTCMARKET/name/REGSHODAILY?$top=500&$orderby=tradeReportDate%20desc");
          if (resp.ok) {
            const csvText = await resp.text();
            const lines = csvText.trim().split("\n");
            if (lines.length >= 2) {
              const csvHeaders = lines[0].split(",");
              const symIdx = csvHeaders.indexOf("securitiesInformationProcessorSymbolIdentifier");
              const tvIdx = csvHeaders.indexOf("totalParQuantity");
              const svIdx = csvHeaders.indexOf("shortParQuantity");
              const dtIdx = csvHeaders.indexOf("tradeReportDate");

              const rows: Array<{fecha: string; total_vol: number; short_vol: number; short_pct: number}> = [];
              for (let i = 1; i < lines.length && rows.length < 500; i++) {
                const vals = lines[i].split(",");
                const symbol = (vals[symIdx] || "").trim();
                if (symbol !== sym) continue;
                const tv = Number(vals[tvIdx] || 0);
                const sv = Number(vals[svIdx] || 0);
                if (tv <= 0) continue;
                rows.push({
                  fecha: (vals[dtIdx] || "").trim(),
                  total_vol: Math.round(tv),
                  short_vol: Math.round(sv),
                  short_pct: Math.round(sv / tv * 1000) / 10,
                });
              }
              if (rows.length) {
                result[sym] = rows;
                return;
              }
            }
          }
        } catch {
          // FINRA también falló
        }

        result[sym] = [];
      }));

      return new Response(JSON.stringify(result), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── Legacy Modo 5: FINRA Short Volume (deprecated, rename kept for compat) ─
    if (mode === "finra-short-volume") {
      if (!symbols?.length) throw new Error("symbols requerido");

      const result: Record<string, Array<{fecha: string; total_vol: number; short_vol: number; short_pct: number}>> = {};

      await Promise.all(symbols.map(async (sym) => {
        try {
          // FINRA API: POST endpoint no parsea JSON correctamente, usamos GET y filtramos localmente
          // Descargamos dataset del ultimo mes (500 rows es suficiente)
          const resp = await fetch("https://api.finra.org/data/group/OTCMARKET/name/REGSHODAILY?$top=500&$orderby=tradeReportDate%20desc");

          if (!resp.ok) {
            result[sym] = [];
            return;
          }

          const csvText = await resp.text();
          const lines = csvText.trim().split("\n");
          if (lines.length < 2) {
            result[sym] = [];
            return;
          }

          const csvHeaders = lines[0].split(",");
          const symIdx = csvHeaders.indexOf("securitiesInformationProcessorSymbolIdentifier");
          const tvIdx = csvHeaders.indexOf("totalParQuantity");
          const svIdx = csvHeaders.indexOf("shortParQuantity");
          const dtIdx = csvHeaders.indexOf("tradeReportDate");

          const rows: Array<{fecha: string; total_vol: number; short_vol: number; short_pct: number}> = [];
          for (let i = 1; i < lines.length && rows.length < 500; i++) {
            const vals = lines[i].split(",");
            const symbol = (vals[symIdx] || "").trim();
            if (symbol !== sym) continue;
            const tv = Number(vals[tvIdx] || 0);
            const sv = Number(vals[svIdx] || 0);
            if (tv <= 0) continue;
            rows.push({
              fecha: (vals[dtIdx] || "").trim(),
              total_vol: Math.round(tv),
              short_vol: Math.round(sv),
              short_pct: Math.round(sv / tv * 1000) / 10,
            });
          }

          result[sym] = rows;
        } catch {
          result[sym] = [];
        }
      }));

      return new Response(JSON.stringify(result), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }


    // ── Modo 8: screener PE + precio batch ────────────────────
    if (mode === "screener-pe") {
      const syms: string[] = (body as any).symbols || [];
      if (!syms.length) throw new Error("symbols requerido");
      const { crumb, cookie } = await getYahooCrumb();
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${syms.join(",")}&fields=symbol,trailingPE,forwardPE,regularMarketPrice,marketCap,shortName&crumb=${encodeURIComponent(crumb)}`;
      const resp = await fetch(url, { headers: { "User-Agent": UA, "Cookie": cookie } });
      const data = resp.ok ? await resp.json() : null;
      const quotes = data?.quoteResponse?.result || [];
      return new Response(JSON.stringify(quotes), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    // ── Modo 9: screener EMA200 semanal ──────────────────────
    if (mode === "screener-ema") {
      const syms: string[] = (body as any).symbols || [];
      if (!syms.length) throw new Error("symbols requerido");
      const { crumb, cookie } = await getYahooCrumb();
      const results = await Promise.all(syms.map(async (sym) => {
        try {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1wk&range=5y&crumb=${encodeURIComponent(crumb)}`;
          const resp = await fetch(url, { headers: { "User-Agent": UA, "Cookie": cookie } });
          if (!resp.ok) return { symbol: sym, error: resp.status };
          const data = await resp.json();
          const result = data?.chart?.result?.[0];
          if (!result) return { symbol: sym, error: "no data" };
          const closes = (result.indicators?.quote?.[0]?.close || []).filter((c: number|null) => c != null) as number[];
          if (closes.length < 50) return { symbol: sym, error: "insuf", count: closes.length };
          const k = 2 / (200 + 1);
          let ema = closes[0];
          for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
          const price = closes[closes.length - 1];
          const pct = Math.round(((price - ema) / ema) * 1000) / 10;
          return { symbol: sym, price: Math.round(price * 100) / 100, ema200w: Math.round(ema * 100) / 100, pctFromEma200w: pct };
        } catch (e) { return { symbol: sym, error: String(e) }; }
      }));
      return new Response(JSON.stringify(results), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // ── Modo 7: datos AF (chart + fundamentals + Finnhub) ────
    if (mode === "af-data") {
      const ticker = (body as any).ticker as string;
      const range  = (body as any).range || "5y";
      if (!ticker) throw new Error("ticker requerido");
      const FINNHUB_KEY = Deno.env.get("FINNHUB_KEY") || "";
      const fhGet = (path: string) => FINNHUB_KEY
        ? fetch(`https://finnhub.io/api/v1${path}&token=${FINNHUB_KEY}`)
            .then(r => r.ok ? r.json() : null).catch(() => null)
        : Promise.resolve(null);
      const { crumb, cookie } = await getYahooCrumb();
      const saFetch = fetch(
        `https://stockanalysis.com/stocks/${ticker.toLowerCase()}/financials/?p=quarterly`,
        { headers: { "User-Agent": UA } }
      ).then(r => r.ok ? r.text() : null).catch(() => null);

      const [chartResp, summaryResp, fhEarnings, fhRec, fhTarget, fhMetrics, saHtml] = await Promise.all([
        fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1wk&range=${range}&includePrePost=false&crumb=${encodeURIComponent(crumb)}`,
          { headers: { "User-Agent": UA, "Cookie": cookie } }),
        fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=incomeStatementHistoryQuarterly,incomeStatementHistory,defaultKeyStatistics,price&crumb=${encodeURIComponent(crumb)}`,
          { headers: { "User-Agent": UA, "Cookie": cookie } }),
        fhGet(`/stock/earnings?symbol=${ticker}&limit=25`),
        fhGet(`/stock/recommendation?symbol=${ticker}`),
        fhGet(`/stock/price-target?symbol=${ticker}`),
        fhGet(`/stock/metric?symbol=${ticker}&metric=all`),
        saFetch,
      ]);
      const chart   = chartResp.ok   ? await chartResp.json()   : null;
      const summary = summaryResp.ok ? await summaryResp.json() : null;

      // Parse quarterly revenue from stockanalysis HTML
      let saRevQ: Array<{date: string; rev: number}> = [];
      if (saHtml) {
        const dates: string[] = [];
        const dateRe = /<th id="(\d{4}-\d{2}-\d{2})"/g;
        let dm: RegExpExecArray | null;
        while ((dm = dateRe.exec(saHtml)) !== null) dates.push(dm[1]);
        const qDates = dates.slice(0, 20);
        const tickerLow = ticker.toLowerCase();
        const revHrefIdx = saHtml.indexOf(`href="/stocks/${tickerLow}/revenue/"`);
        if (revHrefIdx > -1) {
          const afterRev = saHtml.slice(revHrefIdx, revHrefIdx + 4000);
          const vals: number[] = [];
          const tdRe = /<td[^>]*class="bolded[^"]*"[^>]*>([\d,\.]+)<\/td>/g;
          let tv: RegExpExecArray | null;
          while ((tv = tdRe.exec(afterRev)) !== null && vals.length < 20)
            vals.push(parseFloat(tv[1].replace(/,/g, "")));
          saRevQ = qDates.map((d, i) => ({ date: d, rev: vals[i] ?? 0 })).filter(r => r.rev > 0);
        }
      }

      return new Response(JSON.stringify({
        chart, summary, saRevQ,
        finnhub: { earnings: fhEarnings, recommendations: fhRec, priceTarget: fhTarget, metrics: fhMetrics }
      }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // ── Modo 6: histórico Yahoo Finance (benchmark) ─────────
    if (mode === "yahoo-history") {
      if (!symbols?.length) throw new Error("symbols requerido");
      const startDate = (body as any).startDate || new Date(Date.now() - 365*86400*1000).toISOString().split("T")[0];
      const { crumb, cookie } = await getYahooCrumb();
      const period1 = Math.floor(new Date(startDate).getTime() / 1000);
      const period2 = Math.floor(Date.now() / 1000);
      const result: Record<string, Array<{fecha: string; close: number}>> = {};
      await Promise.all(symbols.map(async (sym) => {
        try {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${period1}&period2=${period2}&interval=1d&crumb=${encodeURIComponent(crumb)}`;
          const resp = await fetch(url, { headers: { "User-Agent": UA, "Cookie": cookie } });
          if (!resp.ok) { result[sym] = []; return; }
          const data = await resp.json();
          const chart = data?.chart?.result?.[0];
          if (!chart) { result[sym] = []; return; }
          const timestamps: number[] = chart.timestamp || [];
          const opens: number[]   = chart.indicators?.quote?.[0]?.open   || [];
          const highs: number[]   = chart.indicators?.quote?.[0]?.high   || [];
          const lows: number[]    = chart.indicators?.quote?.[0]?.low    || [];
          const closes: number[]  = chart.indicators?.quote?.[0]?.close  || [];
          result[sym] = timestamps
            .map((ts, i) => ({
              fecha: new Date(ts * 1000).toISOString().split("T")[0],
              open: opens[i] ?? null,
              high: highs[i] ?? null,
              low:  lows[i]  ?? null,
              close: closes[i] ?? null,
            }))
            .filter((r): r is {fecha: string; open: number; high: number; low: number; close: number} => r.close != null);
        } catch { result[sym] = []; }
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


