// ══════════════════════════════════════════════════════════════════
// monitor-cron — Edge function consolidada
// Reemplaza monitor_local.sh + monitor_usa.sh (WSL)
//
// POST { task: "..." }   tasks:
//   watchdog-ars        - alerta si mercado stale
//   watchdog-usa        - alerta si mercado_usa stale
//   dolar-snapshot      - fetch MEP/CCL/Oficial/Blue/Mayorista
//   pnl-snapshot        - calcula PnL diario por usuario
//   resumen-telegram    - resumen diario MEP/CCL/Oficial
//   earnings-watch      - alerta earnings proximos del portafolio
//   health-check        - verifica yahoo-prices responde
//   historico-refresh   - rellena historico_precios con datos faltantes
// ══════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

const SB_URL = "https://endymbpdayeidromxayb.supabase.co";
const SB_KEY = Deno.env.get("SB_ANON_KEY") || "";
const SB_SR  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const TG_TOKEN = Deno.env.get("TG_TOKEN") || "";
const TG_CHAT  = Deno.env.get("TG_CHAT_ID") || "6209263987";

const sb   = createClient(SB_URL, SB_KEY);
const sbSR = createClient(SB_URL, SB_SR);

function todayART(): string {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 3);
  return d.toISOString().slice(0, 10);
}
async function tgSend(text: string) {
  if (!TG_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML" }),
    });
  } catch (_) {}
}

// 1. Watchdog ARS
async function watchdogArs() {
  const { data } = await sb.from("mercado")
    .select("updated_at").order("updated_at", { ascending: false }).limit(1);
  if (!data?.length) return { ok: false, msg: "Sin datos en mercado" };
  const fresh = new Date(data[0].updated_at).getTime();
  const ageMin = (Date.now() - fresh) / 60000;
  if (ageMin > 8) {
    await tgSend(`⚠️ <b>WATCHDOG ARS</b>\nMercado sin actualizar hace ${Math.round(ageMin)} min`);
    return { ok: false, ageMin };
  }
  return { ok: true, ageMin };
}

// 2. Watchdog USA
async function watchdogUsa() {
  const { data } = await sb.from("mercado_usa")
    .select("updated_at").order("updated_at", { ascending: false }).limit(1);
  if (!data?.length) return { ok: false, msg: "Sin datos en mercado_usa" };
  const fresh = new Date(data[0].updated_at).getTime();
  const ageMin = (Date.now() - fresh) / 60000;
  if (ageMin > 8) {
    await tgSend(`⚠️ <b>WATCHDOG USA</b>\nmercado_usa sin actualizar hace ${Math.round(ageMin)} min`);
    return { ok: false, ageMin };
  }
  return { ok: true, ageMin };
}

// 3. Dolar snapshot
async function dolarSnapshot() {
  const hoy = todayART();
  const out: any = { fecha: hoy, sources: [] };

  // A) MEP/CCL via AL30/AL30D/AL30C (Rava)
  try {
    const r = await fetch(`${SB_URL}/functions/v1/yahoo-prices`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      body: JSON.stringify({ mode: "rava-series", symbols: ["AL30", "AL30D", "AL30C"] }),
    });
    const d = await r.json();
    const lastClose = (sym: string) => {
      const arr = d[sym] || [];
      const row = arr.find((x: any) => x.fecha === hoy && x.cierre > 0);
      return row ? Number(row.cierre) : 0;
    };
    const ars = lastClose("AL30");
    const usd = lastClose("AL30D");
    const cclT = lastClose("AL30C");
    if (ars > 0 && usd > 0) {
      const mep = Math.round((ars / usd) * 100) / 100;
      await sbSR.from("mep_historico").upsert(
        { fecha: hoy, mep, al30_ars: ars, al30d_usd: usd, fuente: "rava" },
        { onConflict: "fecha" }
      );
      await sbSR.from("dolar_historico").insert({ fecha: hoy, tipo: "mep", close: mep, fuente: "rava" });
      out.mep = mep; out.sources.push("rava-mep");
    }
    if (ars > 0 && cclT > 0) {
      const ccl = Math.round((ars / cclT) * 100) / 100;
      await sbSR.from("dolar_historico").insert({ fecha: hoy, tipo: "ccl", close: ccl, fuente: "rava" });
      out.ccl = ccl; out.sources.push("rava-ccl");
    }
  } catch (e) { out.errors = [String(e)]; }

  // B) Resto via dolarapi.com
  try {
    const r = await fetch("https://dolarapi.com/v1/dolares", {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const dl = await r.json();
    const find = (casa: string) => {
      const x = (dl as any[]).find((d) => d.casa === casa);
      return x?.venta || 0;
    };
    const map: Record<string, string> = {
      oficial: "oficial", blue: "blue", mayorista: "mayorista",
      bolsa: "mep", contadoconliqui: "ccl",
    };
    for (const [casa, tipo] of Object.entries(map)) {
      const v = find(casa);
      if (v > 0) {
        await sbSR.from("dolar_historico").insert({ fecha: hoy, tipo, close: v, fuente: "dolarapi" });
        out[tipo + "_dolarapi"] = v;
      }
    }
    if (!out.mep && find("bolsa") > 0) {
      const mep = find("bolsa");
      await sbSR.from("mep_historico").upsert(
        { fecha: hoy, mep, fuente: "dolarapi" }, { onConflict: "fecha" }
      );
      out.mep = mep; out.sources.push("dolarapi-mep");
    }
  } catch (_) { /* swallow */ }

  return out;
}

// 4. PnL Snapshot
async function pnlSnapshot() {
  const hoy = todayART();
  const { data: mepRow } = await sb.from("mep_historico")
    .select("mep").eq("fecha", hoy).limit(1);
  const mep = Number(mepRow?.[0]?.mep || 0);
  if (mep <= 0) return { ok: false, msg: "Sin MEP para hoy" };

  const { data: users } = await sb.from("portafolio")
    .select("user_email").eq("activo", true);
  const emails = [...new Set((users || []).map((u: any) => u.user_email).filter(Boolean))];
  if (!emails.length) return { ok: false, msg: "Sin usuarios" };

  const BONOS = ["BONO_SOBERANO", "DOLAR_LINKED", "BONO_CER", "BONO_DUAL"];
  const processed: any[] = [];

  for (const email of emails) {
    const chk = await sb.from("pnl_diario")
      .select("fecha").eq("user_email", email).eq("fecha", hoy).limit(1);
    if (chk.data?.length) { processed.push({ email, status: "skip-exists" }); continue; }

    const pos = await sb.from("portafolio")
      .select("ticker_ars,tipo,cantidad,fecha_compra")
      .eq("user_email", email).eq("activo", true).neq("tipo", "OPCION");
    if (!pos.data?.length) { processed.push({ email, status: "no-positions" }); continue; }

    const td = await sb.from("trades")
      .select("ganancia_usd")
      .eq("user_email", email).eq("tipo", "CEDEAR")
      .eq("fecha_cierre", hoy).lt("fecha_apertura", hoy);
    const realizedGain = (td.data || []).reduce((s: number, t: any) => s + Number(t.ganancia_usd || 0), 0);

    const ti = await sb.from("trades")
      .select("ganancia_usd")
      .eq("user_email", email).eq("tipo", "CEDEAR")
      .eq("fecha_apertura", hoy).eq("fecha_cierre", hoy);
    const intradayGain = (ti.data || []).reduce((s: number, t: any) => s + Number(t.ganancia_usd || 0), 0);

    const ta = await sb.from("trades")
      .select("ticker_ars,cantidad")
      .eq("user_email", email).eq("tipo", "CEDEAR")
      .gt("fecha_cierre", hoy);
    const tradesAbiertos = ta.data || [];

    const tickers = [...new Set([
      ...pos.data.map((p: any) => p.ticker_ars),
      ...tradesAbiertos.map((t: any) => t.ticker_ars),
    ])];
    const pxR = await sb.from("mercado").select("symbol,last").in("symbol", tickers);
    const px: Record<string, number> = {};
    for (const r of (pxR.data || [])) if (r.last) px[r.symbol] = Number(r.last);

    let totalUsd = 0;
    for (const p of pos.data) {
      const precio = px[p.ticker_ars];
      if (!precio) continue;
      const factor = BONOS.includes(p.tipo) ? 100 : 1;
      totalUsd += (Number(p.cantidad) * precio) / (factor * mep);
    }
    for (const t of tradesAbiertos) {
      const precio = px[t.ticker_ars];
      if (precio) totalUsd += (Number(t.cantidad) * precio) / mep;
    }
    totalUsd = Math.round(totalUsd * 100) / 100;
    if (totalUsd <= 0) { processed.push({ email, status: "zero-value" }); continue; }

    const ayer = await sb.from("pnl_diario")
      .select("valor_usd").eq("user_email", email).lt("fecha", hoy)
      .order("fecha", { ascending: false }).limit(1);
    let pnlUsd = null, pnlPct = null;
    const v0 = Number(ayer.data?.[0]?.valor_usd || 0);
    if (v0 > 0) {
      pnlUsd = Math.round((totalUsd - v0 + realizedGain + intradayGain) * 100) / 100;
      pnlPct = Math.round((pnlUsd / v0) * 1000000) / 10000;
    }

    await sbSR.from("pnl_diario").upsert(
      { user_email: email, fecha: hoy, valor_usd: totalUsd, pnl_usd: pnlUsd, pnl_pct: pnlPct },
      { onConflict: "user_email,fecha" }
    );
    processed.push({ email, valor_usd: totalUsd, pnl_usd: pnlUsd });
  }
  return { ok: true, processed: processed.length, detail: processed };
}

// 5. Resumen Telegram
async function resumenTelegram() {
  const hoy = todayART();
  const { data: mepRow } = await sb.from("mep_historico").select("mep").eq("fecha", hoy).limit(1);
  const { data: cclRow } = await sb.from("dolar_historico").select("close").eq("fecha", hoy).eq("tipo", "ccl").limit(1);
  const { data: ofiRow } = await sb.from("dolar_historico").select("close").eq("fecha", hoy).eq("tipo", "oficial").limit(1);
  const mep = mepRow?.[0]?.mep;
  const ccl = cclRow?.[0]?.close;
  const ofi = ofiRow?.[0]?.close;
  const msg = `🏛️ <b>Resumen Diario — ${hoy}</b>\nMEP: <b>$${mep ?? "N/A"}</b>\nCCL: <b>$${ccl ?? "N/A"}</b>\nOficial: <b>$${ofi ?? "N/A"}</b>`;
  await tgSend(msg);
  return { ok: true, mep, ccl, ofi };
}

// 6. Earnings Watch
async function earningsWatch() {
  const { data: porR } = await sb.from("portafolio")
    .select("ticker_adr").eq("activo", true).eq("tipo", "CEDEAR").not("ticker_adr", "is", null);
  const adrs = [...new Set((porR || []).map((r: any) => r.ticker_adr).filter(Boolean))];
  if (!adrs.length) return { ok: true, msg: "Sin ADRs" };

  const r = await fetch(`${SB_URL}/functions/v1/yahoo-prices`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    body: JSON.stringify({ action: "earnings", symbols: adrs }),
  });
  const data = await r.json();
  const now = Date.now() / 1000;
  const horizon = now + 14 * 86400;
  const alerts: string[] = [];
  for (const sym of adrs) {
    const d = (data as any)[sym];
    if (!d) continue;
    const epoch = Array.isArray(d.earningsDate) ? d.earningsDate[0] : d.earningsDate;
    if (typeof epoch === "number") {
      const e = epoch > 1e12 ? epoch / 1000 : epoch;
      if (e > now && e < horizon) {
        const ds = new Date(e * 1000).toISOString().slice(0, 10);
        alerts.push(`📅 ${sym}: earnings ${ds}`);
      }
    }
  }
  if (alerts.length) {
    await tgSend(`📊 <b>Earnings Próximos</b>\n${alerts.join("\n")}`);
  }
  return { ok: true, alerts: alerts.length };
}

// 7. Health check
async function healthCheck() {
  try {
    const r = await fetch(`${SB_URL}/functions/v1/yahoo-prices`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      body: JSON.stringify({ symbols: ["SPY"] }),
    });
    if (!r.ok) await tgSend(`⚠️ yahoo-prices HTTP ${r.status}`);
    return { ok: r.ok, status: r.status };
  } catch (e) {
    await tgSend(`⚠️ yahoo-prices error: ${String(e).slice(0, 200)}`);
    return { ok: false, error: String(e) };
  }
}

// 8. Historico refresh
async function historicoRefresh() {
  const { data: latest } = await sb.from("historico_precios")
    .select("fecha").order("fecha", { ascending: false }).limit(1);
  const lastFecha = latest?.[0]?.fecha || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const { data: uni } = await sb.from("mercado_usa").select("symbol");
  const syms = (uni || []).map((r: any) => r.symbol).filter(Boolean);
  if (!syms.length) return { ok: false, msg: "Sin universo" };
  const from = lastFecha;
  const to = new Date().toISOString().slice(0, 10);

  const BATCH = 10;
  let totalRows = 0;
  for (let i = 0; i < syms.length; i += BATCH) {
    const batch = syms.slice(i, i + BATCH);
    try {
      const r = await fetch(`${SB_URL}/functions/v1/fetch-historical`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
        body: JSON.stringify({ symbols: batch, from, to, persist: true }),
      });
      const d = await r.json();
      totalRows += d._persist?.inserted || 0;
    } catch (_) {}
  }
  return { ok: true, from, to, total_rows: totalRows };
}

const TASKS: Record<string, () => Promise<any>> = {
  "watchdog-ars": watchdogArs,
  "watchdog-usa": watchdogUsa,
  "dolar-snapshot": dolarSnapshot,
  "pnl-snapshot": pnlSnapshot,
  "resumen-telegram": resumenTelegram,
  "earnings-watch": earningsWatch,
  "health-check": healthCheck,
  "historico-refresh": historicoRefresh,
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { task } = await req.json();
    const handler = TASKS[task];
    if (!handler) {
      return new Response(JSON.stringify({ error: `Unknown task: ${task}`, available: Object.keys(TASKS) }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const result = await handler();
    return new Response(JSON.stringify({ task, ...result }),
      { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
