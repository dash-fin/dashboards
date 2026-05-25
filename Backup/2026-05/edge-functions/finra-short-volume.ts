// ═══ finra-short-volume/index.ts ═══
// ══════════════════════════════════════════════════════════════════
// Supabase Edge Function: finra-short-volume
// Sirve Short Volume diario desde cache local en Supabase.
// Mode "refresh": descarga el último archivo del CDN FINRA y lo cachea.
//
// POST { symbol: "AAPL", days: 45 }
// POST { action: "refresh" }  → descarga y cachea últimos archivos
// ══════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

function calcPercentile(values: number[], current: number): number {
  if (values.length < 10) return 50;
  const sorted = [...values].sort((a, b) => a - b);
  let count = 0;
  for (const v of sorted) { if (v <= current) count++; }
  return Math.round((count / sorted.length) * 100);
}

function movingAvg(values: number[], window: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < window - 1) { result.push(null); }
    else {
      let sum = 0;
      for (let j = i - window + 1; j <= i; j++) sum += values[j];
      result.push(sum / window);
    }
  }
  return result;
}

// ── Download and cache a single CNMS file ──────────────────────
async function downloadAndCache(sb: any, dateStr: string): Promise<number> {
  const url = `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${dateStr}.txt`;
  const resp = await fetch(url, { headers: { "User-Agent": UA } });
  if (!resp.ok) return 0;
  
  const text = await resp.text();
  const lines = text.trim().split("\n");
  const ymd = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
  
  // Build batch upsert
  const batch: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split("|");
    if (parts.length < 6) continue;
    const sym = parts[1]?.trim()?.toUpperCase();
    if (!sym || sym.length > 5) continue;
    const svRaw = parts[2]?.trim()?.replace(/,/g, "") || "0";
    const tvRaw = parts[4]?.trim()?.replace(/,/g, "") || "0";
    const sv = Math.round(parseFloat(svRaw));
    const tv = Math.round(parseFloat(tvRaw));
    if (tv === 0) continue;
    batch.push({
      ticker: sym,
      trade_date: ymd,
      short_volume: sv,
      total_volume: tv,
      market: parts[5]?.trim() || "",
    });
  }
  
  if (batch.length === 0) return 0;
  
  // Upsert in chunks
  let inserted = 0;
  for (let j = 0; j < batch.length; j += 500) {
    const chunk = batch.slice(j, j + 500);
    try {
      await sb.from("cache_finra_short_volume").upsert(chunk, {
        onConflict: "ticker,trade_date,market",
        ignoreDuplicates: true,
      });
      inserted += chunk.length;
    } catch (_e) { /* ignore */ }
  }
  return inserted;
}

// ── Get last weekday date string (YYYYMMDD) ────────────────────
function getLastWeekday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1); // yesterday (today's data may not be published)
  let w = d.getUTCDay();
  if (w === 0) d.setUTCDate(d.getUTCDate() - 2); // Sun → Fri
  if (w === 6) d.setUTCDate(d.getUTCDate() - 1); // Sat → Fri
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// ── Refresh mode ───────────────────────────────────────────────
async function handleRefresh(sb: any): Promise<any> {
  const today = getLastWeekday();
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 2);
  const yStr = yesterday.toISOString().slice(0, 10).replace(/-/g, "");
  
  // Check if we already have today's data
  const ymd = `${today.slice(0,4)}-${today.slice(4,6)}-${today.slice(6,8)}`;
  const { count } = await sb
    .from("cache_finra_short_volume")
    .select("*", { count: "exact", head: true })
    .eq("trade_date", ymd)
    .limit(1);
  
  if (count && count > 0) {
    // Already cached, try yesterday too
    const ymd2 = `${yStr.slice(0,4)}-${yStr.slice(4,6)}-${yStr.slice(6,8)}`;
    const { count: c2 } = await sb
      .from("cache_finra_short_volume")
      .select("*", { count: "exact", head: true })
      .eq("trade_date", ymd2)
      .limit(1);
    
    if (c2 && c2 > 0) {
      return { status: "ok", note: "Datos ya actualizados", last_date: ymd };
    }
  }
  
  // Download latest files
  let total = 0;
  total += await downloadAndCache(sb, today);
  total += await downloadAndCache(sb, yStr);
  
  // Also try 3 days back (in case of holidays)
  const d3 = new Date();
  d3.setUTCDate(d3.getUTCDate() - 4);
  const d3Str = d3.toISOString().slice(0, 10).replace(/-/g, "");
  if (d3Str !== today && d3Str !== yStr) {
    total += await downloadAndCache(sb, d3Str);
  }
  
  return { status: "ok", files_downloaded: total > 0 ? "yes" : "no", rows_inserted: total };
}

// ══════════════════════════════════════════════════════════════════
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json();
    const sbKey = req.headers.get("apikey") || "";
    
    // Detect if using anon key or service role key
    const isServiceRole = sbKey.startsWith("sb_secret_") || sbKey.includes("service_role");
    
    const sb = createClient(
      "https://endymbpdayeidromxayb.supabase.co",
      isServiceRole ? sbKey : sbKey
    );
    
    // ── MODE: REFRESH ──────────────────────────────────────────
    if (body.action === "refresh") {
      // Requires service_role key
      if (!isServiceRole) {
        return new Response(JSON.stringify({ error: "Se requiere service_role key para refresh" }), {
          status: 403, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }
      const result = await handleRefresh(sb);
      return new Response(JSON.stringify(result), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    
    // ── MODE: QUERY ────────────────────────────────────────────
    const { symbol, days = 45 } = body;
    if (!symbol) {
      return new Response(JSON.stringify({ error: "symbol requerido" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    
    const sym = symbol.toUpperCase();
    const lookback = Math.max(days, 90);
    
    const { data: cached, error } = await sb
      .from("cache_finra_short_volume")
      .select("trade_date, short_volume, total_volume")
      .eq("ticker", sym)
      .order("trade_date", { ascending: false })
      .limit(5000);
    
    if (error) throw error;
    if (!cached || cached.length === 0) {
      return new Response(
        JSON.stringify({ symbol: sym, data: [], note: "Sin datos en cache" }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }
    
    const byDate = new Map<string, { sv: number; tv: number }>();
    for (const row of cached) {
      const d = row.trade_date;
      const existing = byDate.get(d) || { sv: 0, tv: 0 };
      existing.sv += row.short_volume;
      existing.tv += row.total_volume;
      byDate.set(d, existing);
    }
    
    const sortedDates = [...byDate.keys()].sort();
    const shortPcts = sortedDates.map((d) => {
      const v = byDate.get(d)!;
      return v.tv > 0 ? (v.sv / v.tv) * 100 : 0;
    });
    
    const ma30 = movingAvg(shortPcts, 30);
    
    const data: { fecha: string; total_vol: number; short_vol: number; short_pct: number; ma30: number | null; percentile: number | null }[] = [];
    
    for (let i = 0; i < sortedDates.length; i++) {
      const d = sortedDates[i];
      const v = byDate.get(d)!;
      const pct = shortPcts[i];
      data.push({
        fecha: d,
        total_vol: v.tv,
        short_vol: v.sv,
        short_pct: Math.round(pct * 100) / 100,
        ma30: ma30[i] !== null ? Math.round(ma30[i]! * 100) / 100 : null,
        percentile: data.length >= days
          ? calcPercentile(shortPcts.slice(0, i + 1), pct)
          : null,
      });
    }
    
    return new Response(
      JSON.stringify({ symbol: sym, data: data.slice(-days) }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
