// ══════════════════════════════════════════════════════════════════
// Supabase Edge Function: insider-dataroma
// Scrapea Dataroma.com para obtener datos de superinvestors (13F).
//
// Modos:
//   { mode:"managers" }           → lista de managers
//   { mode:"holdings", manager:"BRK" } → portfolio de un manager
//   { mode:"grand-portfolio" }   → top stocks por # de managers
//   { mode:"activity" }          → actividad reciente global
//   { mode:"insider-buys" }      → insider buys en superinvestor holdings
//   { mode:"auto" }              → todos los modos en una llamada
//   { mode:"all" }               → fuerza refresh de todo
// ══════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const BASE = "https://www.dataroma.com/m";

// ── Helpers ──

async function fetchText(url: string): Promise<string> {
  const resp = await fetch(url, { headers: { "User-Agent": UA } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
  return resp.text();
}

function extractBetween(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  if (i === -1) return "";
  const j = text.indexOf(end, i + start.length);
  return j === -1 ? text.slice(i + start.length) : text.slice(i + start.length, j);
}

function extractTable(html: string, tableIdx: number): string[][] {
  // Simple table extraction by finding <table>...<tr>...<td>
  const rows: string[][] = [];
  let t = html;
  for (let tIdx = 0; tIdx <= tableIdx; tIdx++) {
    const ti = t.indexOf("<table");
    if (ti === -1) return rows;
    t = t.slice(ti + 7);
  }
  // Now extract rows from this table
  let trStart = 0;
  while (true) {
    const trI = t.indexOf("<tr", trStart);
    if (trI === -1) break;
    const trEnd = t.indexOf("</tr>", trI);
    if (trEnd === -1) break;
    const rowHtml = t.slice(trI, trEnd + 5);
    const cells: string[] = [];
    let tdPos = 0;
    while (true) {
      // <td ...> or <th ...>
      const tdI = rowHtml.indexOf("<td", tdPos);
      const thI = rowHtml.indexOf("<th", tdPos);
      let ci = -1;
      if (tdI !== -1 && thI !== -1) ci = Math.min(tdI, thI);
      else if (tdI !== -1) ci = tdI;
      else if (thI !== -1) ci = thI;
      else break;
      const ce = rowHtml.indexOf(">", ci);
      if (ce === -1) break;
      const cEnd = rowHtml.indexOf("</td>", ce);
      const thEnd = rowHtml.indexOf("</th>", ce);
      let cellEnd = -1;
      if (cEnd !== -1 && thEnd !== -1) cellEnd = Math.min(cEnd, thEnd);
      else if (cEnd !== -1) cellEnd = cEnd;
      else if (thEnd !== -1) cellEnd = thEnd;
      else break;
      const cellText = rowHtml.slice(ce + 1, cellEnd).replace(/<[^>]*>/g, "").trim();
      cells.push(cellText);
      tdPos = cellEnd + 5;
    }
    if (cells.length > 0) rows.push(cells);
    trStart = trEnd + 5;
  }
  return rows;
}

function cleanNum(s: string): number {
  return parseFloat(s.replace(/[$,%MKB]/g, "").replace(/,/g, "")) || 0;
}

// ── Mode: managers ──
async function scrapeManagers(): Promise<any[]> {
  const html = await fetchText(`${BASE}/managers.php`);
  const rows = extractTable(html, 0);
  const managers: any[] = [];
  for (const row of rows) {
    if (row.length < 2) continue;
    // First cell usually has a link like holdings.php?m=BRK
    const linkMatch = row[0].match(/holdings\.php\?m=([A-Z0-9]+)/i);
    const code = linkMatch ? linkMatch[1] : "";
    const name = row[0].replace(/<[^>]*>/g, "").trim() || row[1] || "";
    if (code) managers.push({ code, name, source: "dataroma" });
  }
  return managers;
}

// ── Mode: holdings ──
async function scrapeHoldings(managerCode: string): Promise<any> {
  const html = await fetchText(`${BASE}/holdings.php?m=${managerCode}`);
  const rows = extractTable(html, 0);
  const positions: any[] = [];
  for (const row of rows) {
    if (row.length < 6) continue;
    const tickerMatch = row[1]?.match(/[A-Z]+/);
    const ticker = tickerMatch ? tickerMatch[0] : "";
    if (!ticker || ticker === "Ticker") continue;
    const company = row[2] || "";
    const shares = cleanNum(row[3]?.replace(/,/g, ""));
    const pctPortfolio = parseFloat(row[4]?.replace("%", "")) || 0;
    const value = cleanNum(row[5]?.replace(/,/g, ""));
    const activity = row[6] || "";
    const activityPct = parseFloat(row[7]?.replace("%", "")) || 0;
    const pe = parseFloat(row[8]) || 0;
    const yrHigh = parseFloat(row[9]) || 0;
    const yrLow = parseFloat(row[10]) || 0;
    positions.push({
      ticker,
      company,
      shares,
      pct_portfolio: pctPortfolio,
      value,
      activity,
      activity_pct: activityPct,
      pe,
      yr_high: yrHigh,
      yr_low: yrLow,
    });
  }
  return { manager: managerCode, positions, updated_at: new Date().toISOString() };
}

// ── Mode: grand-portfolio (top stocks by manager count) ──
async function scrapeGrandPortfolio(): Promise<any> {
  const html = await fetchText(`${BASE}/g/portfolio.php`);
  const rows = extractTable(html, 0);
  const stocks: any[] = [];
  for (const row of rows) {
    if (row.length < 4) continue;
    const tickerMatch = row[0]?.match(/[A-Z]+/);
    const ticker = tickerMatch ? tickerMatch[0] : "";
    if (!ticker || ticker === "Ticker") continue;
    const company = row[1] || "";
    const managers = parseInt(row[2]?.replace(/,/g, "")) || 0;
    const avgWeight = parseFloat(row[3]?.replace("%", "")) || 0;
    stocks.push({ ticker, company, manager_count: managers, avg_weight: avgWeight });
  }
  return { top_stocks: stocks, updated_at: new Date().toISOString() };
}

// ── Mode: activity ──
async function scrapeActivity(): Promise<any> {
  const html = await fetchText(`${BASE}/allact.php?typ=a`);
  const rows = extractTable(html, 0);
  const activities: any[] = [];
  for (const row of rows) {
    if (row.length < 6) continue;
    const dateStr = row[0]?.trim();
    if (!dateStr || dateStr.includes("Date") || dateStr.includes("--")) continue;
    const managerMatch = row[1]?.match(/holdings\.php\?m=([A-Z0-9]+)/i);
    const manager = managerMatch ? managerMatch[1] : row[1]?.replace(/<[^>]*>/g, "").trim() || "";
    const ticker = row[2]?.replace(/<[^>]*>/g, "").trim() || "";
    const action = row[3]?.trim() || "";
    const sharesChanged = cleanNum(row[4]?.replace(/,/g, ""));
    const pctChanged = parseFloat(row[5]?.replace("%", "")) || 0;
    activities.push({
      date: dateStr,
      manager,
      ticker,
      action,
      shares_changed: sharesChanged,
      pct_changed: pctChanged,
    });
  }
  return { activities, updated_at: new Date().toISOString() };
}

// ── Mode: insider-buys ──
async function scrapeInsiderBuys(): Promise<any> {
  const html = await fetchText(`${BASE}/ins/ins.php`);
  const rows = extractTable(html, 0);
  const buys: any[] = [];
  for (const row of rows) {
    if (row.length < 5) continue;
    const dateStr = row[0]?.trim();
    if (!dateStr || dateStr.includes("Date")) continue;
    const ticker = row[1]?.replace(/<[^>]*>/g, "").trim() || "";
    const company = row[2]?.replace(/<[^>]*>/g, "").trim() || "";
    const totalValue = cleanNum(row[3]?.replace(/,/g, ""));
    const price = parseFloat(row[4]?.replace("$", "")) || 0;
    buys.push({
      filed_date: dateStr,
      ticker,
      company,
      total_value: totalValue,
      price,
    });
  }
  return { insider_buys: buys, updated_at: new Date().toISOString() };
}

// ── Cache check ──
async function getFromCache(sb: any, key: string, maxAgeMs: number): Promise<any | null> {
  const { data } = await sb
    .from("cache_dataroma")
    .select("data, updated_at")
    .eq("cache_key", key)
    .single();
  if (!data) return null;
  const age = Date.now() - new Date(data.updated_at).getTime();
  if (age > maxAgeMs) return null;
  return data.data;
}

async function setCache(sb: any, key: string, payload: any): Promise<void> {
  await sb
    .from("cache_dataroma")
    .upsert({ cache_key: key, data: payload, updated_at: new Date().toISOString() }, { onConflict: "cache_key" });
}

// ── Main handler ──
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json();
    const mode = body.mode || "auto";
    const manager = body.manager || "";
    const cacheDays = body.cache !== false ? 1 : 0; // default: 1 day cache
    const maxAgeMs = cacheDays * 24 * 60 * 60 * 1000;

    const sbUrl = Deno.env.get("SUPABASE_URL") || "";
    const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const sb = createClient(sbUrl, sbKey);

    // Ensure cache table exists (try a select first, create if it fails)
    await sb.from("cache_dataroma").select("cache_key").limit(1).catch(async () => {
      // table doesn't exist — create it via raw SQL over the REST port
      await fetch(sbUrl + "/rest/v1/rpc/", {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": sbKey, "Authorization": "Bearer " + sbKey },
        body: JSON.stringify({ sql: `CREATE TABLE IF NOT EXISTS cache_dataroma (cache_key TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ DEFAULT NOW())` })
      }).catch(() => {
        // last resort — ignore, the query will just fail later
      });
    });

    const result: any = { mode, source: "dataroma" };

    if (mode === "managers") {
      const cacheKey = "managers";
      let data = await getFromCache(sb, cacheKey, maxAgeMs);
      if (!data) {
        data = await scrapeManagers();
        await setCache(sb, cacheKey, data);
      }
      result.managers = data;
    } else if (mode === "holdings" && manager) {
      const cacheKey = `holdings_${manager}`;
      let data = await getFromCache(sb, cacheKey, maxAgeMs);
      if (!data) {
        data = await scrapeHoldings(manager);
        await setCache(sb, cacheKey, data);
      }
      result.holdings = data;
    } else if (mode === "grand-portfolio") {
      const cacheKey = "grand-portfolio";
      let data = await getFromCache(sb, cacheKey, maxAgeMs);
      if (!data) {
        data = await scrapeGrandPortfolio();
        await setCache(sb, cacheKey, data);
      }
      result.top_stocks = data.top_stocks;
      result.updated_at = data.updated_at;
    } else if (mode === "activity") {
      const cacheKey = "activity";
      let data = await getFromCache(sb, cacheKey, maxAgeMs);
      if (!data) {
        data = await scrapeActivity();
        await setCache(sb, cacheKey, data);
      }
      result.activities = data.activities;
      result.updated_at = data.updated_at;
    } else if (mode === "insider-buys") {
      const cacheKey = "insider-buys";
      let data = await getFromCache(sb, cacheKey, maxAgeMs);
      if (!data) {
        data = await scrapeInsiderBuys();
        await setCache(sb, cacheKey, data);
      }
      result.insider_buys = data.insider_buys;
      result.updated_at = data.updated_at;
    } else if (mode === "auto" || mode === "all") {
      // Fetch everything
      const [managers, gp, act, ib] = await Promise.all([
        scrapeManagers(),
        scrapeGrandPortfolio(),
        scrapeActivity(),
        scrapeInsiderBuys(),
      ]);
      result.managers = managers;
      result.top_stocks = gp.top_stocks;
      result.activities = act.activities;
      result.insider_buys = ib.insider_buys;
      result.updated_at = new Date().toISOString();

      // Cache everything
      if (mode === "all") {
        await Promise.all([
          setCache(sb, "managers", managers),
          setCache(sb, "grand-portfolio", gp),
          setCache(sb, "activity", act),
          setCache(sb, "insider-buys", ib),
        ]);
      }
    } else {
      throw new Error(`Unknown mode: ${mode}`);
    }

    return new Response(JSON.stringify(result), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
