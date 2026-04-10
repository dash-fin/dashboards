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

// ── Rava histórico ────────────────────────────────────────────────
function fmtDMY(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

async function fetchRavaClose(sym: string, date: string): Promise<number | null> {
  // Ventana de 7 días hacia atrás para cubrir fines de semana y feriados
  const dateObj = new Date(date + "T12:00:00Z");
  const desde   = new Date(dateObj.getTime() - 7 * 86400000);
  const url = `https://www.rava.com/series/precios.php?e=${encodeURIComponent(sym)}&desde=${fmtDMY(desde.toISOString().split("T")[0])}&hasta=${fmtDMY(date)}&csv=1`;

  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": UA, "Referer": "https://www.rava.com/" },
    });
    if (!resp.ok) return null;

    const text = await resp.text();
    if (text.trim().startsWith("<")) return null; // respuesta HTML = error

    const sep   = text.includes(";") ? ";" : ",";
    const lines = text.trim().split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return null;

    // Detectar columna "Cierre" por header
    const header   = lines[0].split(sep).map(h => h.replace(/"/g, "").trim().toLowerCase());
    const closeIdx = header.findIndex(h => h.includes("cierre") || h.includes("close") || h.includes("último") || h.includes("ultimo"));
    const idx      = closeIdx >= 0 ? closeIdx : 4; // fallback: columna 4 (Fecha,Open,Max,Min,Close)

    // Tomar la última fila (fecha más reciente dentro del rango)
    const lastRow = lines[lines.length - 1].split(sep).map(c => c.replace(/"/g, "").trim());
    const close   = parseFloat(lastRow[idx]?.replace(",", ".") ?? "");
    return isNaN(close) || close <= 0 ? null : close;
  } catch {
    return null;
  }
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

      await Promise.all(symbols.map(async (sym) => {
        result[sym] = {};
        await Promise.all(dates.map(async (date) => {
          result[sym][date] = await fetchRavaClose(sym, date);
        }));
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
