// ═══ insider-finviz/index.ts ═══
// ══════════════════════════════════════════════════════════════════
// Supabase Edge Function: insider-finviz
// Scrapea Finviz Insider Trading, Managers y Funds.
//
// Modos:
//   { mode:"insider", ticker:"AAPL" }       → transacciones por ticker
//   { mode:"managers" }                     → lista managers 13F + datos embebidos
//   { mode:"manager-detail", investorId:"1446194" } → holdings de un manager
//   { mode:"funds" }                        → lista funds N-PORT + datos embebidos
// ══════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const BASE = "https://finviz.com";
const MAX_PAGES = 5; // max pages to scrape for manager/fund lists

// ── Helpers ──

async function fetchText(url: string): Promise<string> {
  const resp = await fetch(url, { headers: { "User-Agent": UA } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
  return resp.text();
}

function extractJSONArrays(html: string): any[] {
  // Extract JSON arrays from HTML: [ {...}, ... ]
  const arrays: any[] = [];
  const regex = /\[\s*\{.*?\}\s*\]/gs;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        arrays.push(parsed);
      }
    } catch {
      // skip malformed arrays
    }
  }
  return arrays;
}

function extractInsiderTable(html: string): any[] {
  // Parse the insider trading table from Finviz HTML
  const rows: any[] = [];
  // Find the table with id="insider-table"
  const tableMatch = html.match(/<table[^>]*id="insider-table"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return rows;

  const tableHtml = tableMatch[1];
  // Find all <tr> elements
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRegex.exec(tableHtml)) !== null) {
    const trHtml = trMatch[1];
    // Extract <td> elements
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    let tdMatch;
    while ((tdMatch = tdRegex.exec(trHtml)) !== null) {
      const cellText = tdMatch[1].replace(/<[^>]*>/g, "").trim();
      cells.push(cellText);
    }
    if (cells.length >= 9) {
      const ticker = cells[0];
      if (!ticker || ticker === "Ticker") continue;
      const owner = cells[1];
      const relationship = cells[2];
      const dateStr = cells[3];
      const transaction = cells[4];
      const cost = parseFloat(cells[5]?.replace(/[$,]/g, "")) || 0;
      const shares = parseInt(cells[6]?.replace(/,/g, "")) || 0;
      const value = parseFloat(cells[7]?.replace(/[$,]/g, "")) || 0;
      const sharesTotal = parseInt(cells[8]?.replace(/,/g, "")) || 0;
      const secLink = cells[9] || "";

      rows.push({
        ticker,
        owner,
        relationship,
        date: dateStr,
        transaction,
        cost,
        shares,
        value,
        shares_total: sharesTotal,
        sec_link: secLink,
      });
    }
  }
  return rows;
}

function extractEmbeddedPageData(html: string): {
  filerList: any[];
  holdingsEntries: { topHoldings: any[]; quarterSummaries: any[] }[];
} {
  const arrays = extractJSONArrays(html);
  const filerList: any[] = [];
  const holdingsEntries: { topHoldings: any[]; quarterSummaries: any[] }[] = [];

  let currentEntry: { topHoldings: any[]; quarterSummaries: any[] } | null = null;

  for (const arr of arrays) {
    if (arr.length === 0) continue;

    // Check if this is a filer list (has "filer" key)
    if (arr[0].filer && arr[0].filer.investorId) {
      filerList.push(...arr);
      continue;
    }

    // Check if this is a top holdings list (has "ticker" and "boxoverData" and "percentageOfPortfolio")
    if (
      arr[0].ticker &&
      arr[0].boxoverData &&
      arr[0].percentageOfPortfolio !== undefined
    ) {
      if (!currentEntry) currentEntry = { topHoldings: [], quarterSummaries: [] };
      currentEntry.topHoldings = arr;
      continue;
    }

    // Check if this is a quarter summaries list (has "investorId" and "totalCountOfInvestments")
    if (
      arr[0].investorId &&
      arr[0].totalCountOfInvestments !== undefined
    ) {
      if (!currentEntry) currentEntry = { topHoldings: [], quarterSummaries: [] };
      currentEntry.quarterSummaries = arr;
      continue;
    }

    // If we have completed entries, save and reset
    if (currentEntry && currentEntry.topHoldings.length > 0 && currentEntry.quarterSummaries.length > 0) {
      holdingsEntries.push(currentEntry);
      currentEntry = null;
    }
  }

  // Push last entry if complete
  if (currentEntry && currentEntry.topHoldings.length > 0) {
    holdingsEntries.push(currentEntry);
  }

  return { filerList, holdingsEntries };
}

// ── Mode: insider (by ticker) ──
async function scrapeInsiderByTicker(ticker: string): Promise<any> {
  const html = await fetchText(`${BASE}/insidertrading?t=${ticker.toUpperCase()}&o=-transactionValue&v=3`);
  const trades = extractInsiderTable(html);

  // Also get basic quote stats
  const quoteHtml = await fetchText(`${BASE}/quote.ashx?t=${ticker.toUpperCase()}`);

  // Extract insider metrics from quote
  const insiderOwn = quoteHtml.match(/Insider Own[^<]*<[^>]*>([^<]*)/i);
  const insiderTrans = quoteHtml.match(/Insider Trans[^<]*<[^>]*>([^<]*)/i);
  const instOwn = quoteHtml.match(/Inst Own[^<]*<[^>]*>([^<]*)/i);
  const instTrans = quoteHtml.match(/Inst Trans[^<]*<[^>]*>([^<]*)/i);
  const shsFloat = quoteHtml.match(/Shs Float[^<]*<[^>]*>([^<]*)/i);
  const shortFloat = quoteHtml.match(/Short Float[^<]*<[^>]*>([^<]*)/i);

  // Calculate KPIs
  let totalBuyValue = 0;
  let totalSaleValue = 0;
  let buyCount = 0;
  let saleCount = 0;
  const activeInsiders = new Set<string>();

  for (const trade of trades) {
    activeInsiders.add(trade.owner);
    if (
      trade.transaction?.toLowerCase().includes("buy") &&
      !trade.transaction?.toLowerCase().includes("option")
    ) {
      totalBuyValue += trade.value;
      buyCount++;
    } else if (
      trade.transaction?.toLowerCase().includes("sale") &&
      !trade.transaction?.toLowerCase().includes("proposed") &&
      !trade.transaction?.toLowerCase().includes("option")
    ) {
      totalSaleValue += trade.value;
      saleCount++;
    }
  }

  return {
    ticker: ticker.toUpperCase(),
    trades,
    kpis: {
      insider_own_pct: insiderOwn ? parseFloat(insiderOwn[1]?.replace("%", "")) || null : null,
      insider_trans_pct: insiderTrans ? parseFloat(insiderTrans[1]?.replace("%", "")) || null : null,
      inst_own_pct: instOwn ? parseFloat(instOwn[1]?.replace("%", "")) || null : null,
      inst_trans_pct: instTrans ? parseFloat(instTrans[1]?.replace("%", "")) || null : null,
      short_float_pct: shortFloat ? parseFloat(shortFloat[1]?.replace("%", "")) || null : null,
      total_buy_value: totalBuyValue,
      total_sale_value: totalSaleValue,
      net_flow: totalBuyValue - totalSaleValue,
      buy_count: buyCount,
      sale_count: saleCount,
      active_insiders: activeInsiders.size,
      buy_sale_ratio: saleCount > 0 ? (buyCount / saleCount) : buyCount > 0 ? Infinity : 0,
    },
  };
}

// ── Mode: managers ──
async function scrapeManagers(): Promise<any> {
  const allManagers: any[] = [];
  const allHoldingsEntries: any[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * 20;
    const url = `${BASE}/insidertrading/managers${offset > 0 ? `?r=${offset}` : ""}`;
    const html = await fetchText(url);

    const { filerList, holdingsEntries } = extractEmbeddedPageData(html);
    allManagers.push(...filerList);
    allHoldingsEntries.push(...holdingsEntries);

    // If no filers found, we've reached the end
    if (filerList.length === 0) break;
  }

  return {
    managers: allManagers.slice(0, 100), // max 100 managers
    holdings_entries: allHoldingsEntries.slice(0, 100),
    count: Math.min(allManagers.length, 100),
  };
}

// ── Mode: manager-detail ──
async function scrapeManagerDetail(investorId: string): Promise<any> {
  const url = `${BASE}/insidertrading?oc=${investorId}&tc=4`;
  const html = await fetchText(url);

  const arrays = extractJSONArrays(html);
  let topHoldings: any[] = [];
  let quarterSummaries: any[] = [];

  for (const arr of arrays) {
    if (arr.length === 0) continue;
    if (
      arr[0].ticker &&
      arr[0].boxoverData &&
      arr[0].percentageOfPortfolio !== undefined
    ) {
      topHoldings = arr;
    }
    if (
      arr[0].investorId &&
      arr[0].totalCountOfInvestments !== undefined
    ) {
      quarterSummaries = arr;
    }
  }

  return {
    investor_id: investorId,
    top_holdings: topHoldings,
    quarter_summaries: quarterSummaries,
  };
}

// ── Mode: funds ──
async function scrapeFunds(): Promise<any> {
  const allFunds: any[] = [];
  const allHoldingsEntries: any[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * 20;
    const url = `${BASE}/insidertrading/funds${offset > 0 ? `?r=${offset}` : ""}`;
    const html = await fetchText(url);

    const { filerList, holdingsEntries } = extractEmbeddedPageData(html);
    allFunds.push(...filerList);
    allHoldingsEntries.push(...holdingsEntries);

    if (filerList.length === 0) break;
  }

  return {
    funds: allFunds,
    holdings_entries: allHoldingsEntries,
    count: Math.min(allFunds.length, 100),
  };
}

// ── Cache ──
async function getFromCache(sb: any, key: string, maxAgeMs: number): Promise<any | null> {
  const { data } = await sb
    .from("cache_finviz_insider")
    .select("data, metadata, updated_at")
    .eq("cache_key", key)
    .single();
  if (!data) return null;
  const age = Date.now() - new Date(data.updated_at).getTime();
  if (age > maxAgeMs) return null;
  return { data: data.data, metadata: data.metadata };
}

async function setCache(sb: any, key: string, payload: any, metadata?: any): Promise<void> {
  await sb
    .from("cache_finviz_insider")
    .upsert({
      cache_key: key,
      data: payload,
      metadata: metadata || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "cache_key" });
}

// ── Main ──
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json();
    const mode = body.mode || "insider";
    const ticker = body.ticker || "";
    const investorId = body.investorId || "";
    const cacheDays = body.cache !== false ? 1 : 0;
    const maxAgeMs = cacheDays * 24 * 60 * 60 * 1000;

    const sbUrl = Deno.env.get("SUPABASE_URL") || "";
    const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    let sb: any = null;
    try {
      sb = createClient(sbUrl, sbKey);
    } catch {
      // No Supabase available, proceed without cache
    }

    const result: any = { mode, source: "finviz" };

    if (mode === "insider" && ticker) {
      const cacheKey = `insider_${ticker.toUpperCase()}`;
      let cached: any = null;
      if (sb) cached = await getFromCache(sb, cacheKey, maxAgeMs);
      if (cached) {
        result.data = cached.data;
        result.cached = true;
      } else {
        const data = await scrapeInsiderByTicker(ticker);
        result.data = data;
        if (sb) await setCache(sb, cacheKey, data, { ticker: ticker.toUpperCase() });
      }
    } else if (mode === "managers") {
      const cacheKey = "managers";
      let cached: any = null;
      if (sb) cached = await getFromCache(sb, cacheKey, maxAgeMs);
      if (cached) {
        result.data = cached.data;
        result.cached = true;
      } else {
        const data = await scrapeManagers();
        result.data = data;
        if (sb) await setCache(sb, cacheKey, data, { type: "managers" });
      }
    } else if (mode === "manager-detail" && investorId) {
      const cacheKey = `manager_${investorId}`;
      let cached: any = null;
      if (sb) cached = await getFromCache(sb, cacheKey, maxAgeMs);
      if (cached) {
        result.data = cached.data;
        result.cached = true;
      } else {
        const data = await scrapeManagerDetail(investorId);
        result.data = data;
        if (sb) await setCache(sb, cacheKey, data, { investor_id: investorId });
      }
    } else if (mode === "funds") {
      const cacheKey = "funds";
      let cached: any = null;
      if (sb) cached = await getFromCache(sb, cacheKey, maxAgeMs);
      if (cached) {
        result.data = cached.data;
        result.cached = true;
      } else {
        const data = await scrapeFunds();
        result.data = data;
        if (sb) await setCache(sb, cacheKey, data, { type: "funds" });
      }
    } else {
      throw new Error(`Unknown mode or missing params: mode=${mode}, ticker=${ticker}, investorId=${investorId}`);
    }

    return new Response(JSON.stringify(result), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
