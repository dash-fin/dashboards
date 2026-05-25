// ══════════════════════════════════════════════════════════════════
// monitor-cron — Edge function consolidada v2
// POST { task: "..." }   tasks:
//   watchdog-ars        - alerta si mercado stale
//   watchdog-usa        - alerta si mercado_usa stale
//   dolar-snapshot      - fetch MEP/CCL/Oficial/Blue/Mayorista
//   pnl-snapshot        - calcula PnL diario (telescopic formula v2 + leverage)
//   resumen-telegram    - resumen diario MEP/CCL/Oficial
//   earnings-watch      - alerta earnings proximos del portafolio
//   health-check        - verifica yahoo-prices responde
//   historico-refresh   - rellena historico_precios con datos faltantes
//
// pnl-snapshot params opcionales:
//   fecha       (string YYYY-MM-DD) — procesar otro dia
//   user_email  (string)            — procesar solo un usuario
//   source      ('cron'|'manual'|'backfill') — default 'cron'
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
async function watchdogArs(_p?: Record<string, any>) {
  const { data } = await sb.from("mercado")
    .select("updated_at").order("updated_at", { ascending: false }).limit(1);
  if (!data?.length) return { ok: false, msg: "Sin datos en mercado" };
  const ageMin = (Date.now() - new Date(data[0].updated_at).getTime()) / 60000;
  if (ageMin > 8) {
    await tgSend(`⚠️ <b>WATCHDOG ARS</b>\nMercado sin actualizar hace ${Math.round(ageMin)} min`);
    return { ok: false, ageMin };
  }
  return { ok: true, ageMin };
}

// 2. Watchdog USA
async function watchdogUsa(_p?: Record<string, any>) {
  const { data } = await sb.from("mercado_usa")
    .select("updated_at").order("updated_at", { ascending: false }).limit(1);
  if (!data?.length) return { ok: false, msg: "Sin datos en mercado_usa" };
  const ageMin = (Date.now() - new Date(data[0].updated_at).getTime()) / 60000;
  if (ageMin > 8) {
    await tgSend(`⚠️ <b>WATCHDOG USA</b>\nmercado_usa sin actualizar hace ${Math.round(ageMin)} min`);
    return { ok: false, ageMin };
  }
  return { ok: true, ageMin };
}

// 3. Dolar snapshot
async function dolarSnapshot(_p?: Record<string, any>) {
  const hoy = todayART();
  const out: any = { fecha: hoy, sources: [] };

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

  try {
    const r = await fetch("https://dolarapi.com/v1/dolares", { headers: { "User-Agent": "Mozilla/5.0" } });
    const dl = await r.json();
    const find = (casa: string) => ((dl as any[]).find((d) => d.casa === casa))?.venta || 0;
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
      await sbSR.from("mep_historico").upsert({ fecha: hoy, mep, fuente: "dolarapi" }, { onConflict: "fecha" });
      out.mep = mep; out.sources.push("dolarapi-mep");
    }
  } catch (_) {}

  return out;
}

// 4. PnL Snapshot v2
// G_D  = valor total portafolio en USD (posiciones abiertas x last / mep)
// R_D  = ganancia realizada hoy (trades.ganancia_usd donde fecha_cierre = hoy)
// pnl_bruto_D = (G_D - G_{D-1}) + R_D
// pnl_neto_D  = pnl_bruto_D - costo_fin_D (cauciones_tomadas)
// equity_D    = G_D - deuda_D
// roe_D       = pnl_neto_D / equity_{D-1}
async function pnlSnapshot(params: Record<string, any> = {}) {
  const hoy    = params.fecha      || todayART();
  const source = params.source     || "cron";
  const BONOS  = ["BONO_SOBERANO", "DOLAR_LINKED", "BONO_CER", "BONO_DUAL"];

  const { data: mepRow } = await sbSR.from("mep_historico")
    .select("mep").eq("fecha", hoy).limit(1);
  const mep = Number(mepRow?.[0]?.mep || 0);
  if (mep <= 0) return { ok: false, msg: `Sin MEP para ${hoy}` };

  let emails: string[];
  if (params.user_email) {
    emails = [params.user_email];
  } else {
    const { data: users } = await sbSR.from("portafolio")
      .select("user_email").eq("activo", true);
    emails = [...new Set((users || []).map((u: any) => u.user_email).filter(Boolean))];
  }
  if (!emails.length) return { ok: false, msg: "Sin usuarios" };

  const processed: any[] = [];

  for (const email of emails) {
    try {
      // A) G_D: valor portafolio (excluye OPCION, valuadas por separado en futuras versiones)
      const { data: posData } = await sbSR.from("portafolio")
        .select("ticker_ars,tipo,cantidad")
        .eq("user_email", email).eq("activo", true).neq("tipo", "OPCION");

      const tickers = (posData || []).map((p: any) => p.ticker_ars).filter(Boolean);
      const px: Record<string, number> = {};
      if (tickers.length) {
        const { data: pxData } = await sbSR.from("mercado")
          .select("symbol,last").in("symbol", tickers);
        for (const r of (pxData || [])) if (r.last) px[r.symbol] = Number(r.last);
      }

      let gD = 0;
      for (const p of (posData || [])) {
        const precio = px[p.ticker_ars];
        if (!precio) continue;
        const factor = BONOS.includes(p.tipo) ? 100 : 1;
        gD += (Number(p.cantidad) * precio) / (factor * mep);
      }
      gD = Math.round(gD * 100) / 100;

      // B) R_D: ganancia realizada hoy
      const { data: trdData } = await sbSR.from("trades")
        .select("ganancia_usd").eq("user_email", email).eq("fecha_cierre", hoy);
      const rD = Math.round(
        (trdData || []).reduce((s: number, t: any) => s + Number(t.ganancia_usd || 0), 0) * 100
      ) / 100;

      // C) G_{D-1}: valor portafolio dia anterior (de pnl_diario)
      const { data: ayerData } = await sbSR.from("pnl_diario")
        .select("valor_usd,equity_usd")
        .eq("user_email", email).lt("fecha", hoy)
        .order("fecha", { ascending: false }).limit(1);
      const gPrev      = Number(ayerData?.[0]?.valor_usd || 0);
      const equityPrev = Number(ayerData?.[0]?.equity_usd || 0) || gPrev;

      // D) Leverage: cauciones_tomadas
      let deudaD = 0, costoFinD = 0;
      try {
        const { data: dRow } = await sbSR.rpc("deuda_caucion_en_fecha", { p_email: email, p_fecha: hoy });
        deudaD = Number(dRow || 0);
        const { data: cRow } = await sbSR.rpc("costo_caucion_diario", { p_email: email, p_fecha: hoy });
        costoFinD = Math.round(Number(cRow || 0) * 10000) / 10000;
      } catch (_) { /* sin cauciones — normal */ }

      // E) PnL
      const pnlBruto = gPrev > 0 ? Math.round((gD - gPrev + rD) * 100) / 100 : null;
      const pnlNeto  = pnlBruto !== null ? Math.round((pnlBruto - costoFinD) * 100) / 100 : null;
      const pnlPct   = gPrev > 0 && pnlBruto !== null
        ? Math.round((pnlBruto / gPrev) * 1000000) / 10000 : null;
      const equityD   = Math.round((gD - deudaD) * 100) / 100;
      const leverageD = equityD > 0 ? Math.round((gD / equityD) * 1000) / 1000 : null;
      const roeD      = equityPrev > 0 && pnlNeto !== null
        ? Math.round((pnlNeto / equityPrev) * 1000000) / 10000 : null;

      // F) Upsert (siempre, sin skip-exists)
      await sbSR.from("pnl_diario").upsert({
        user_email:           email,
        fecha:                hoy,
        valor_usd:            gD,
        pnl_usd:              pnlBruto,
        pnl_pct:              pnlPct,
        pnl_bruto_usd:        pnlBruto,
        pnl_neto_usd:         pnlNeto,
        pnl_realizado_usd:    rD,
        costo_financiero_usd: costoFinD,
        deuda_usd:            deudaD,
        equity_usd:           equityD,
        leverage_ratio:       leverageD,
        roe_diario:           roeD,
        mep_usado:            mep,
        source,
      }, { onConflict: "user_email,fecha" });

      processed.push({
        email, valor_usd: gD, pnl_bruto: pnlBruto, pnl_neto: pnlNeto,
        equity: equityD, leverage: leverageD, roe_pct: roeD, rD,
      });
    } catch (err) {
      processed.push({ email, error: String(err) });
    }
  }

  return { ok: true, fecha: hoy, mep, source, processed };
}

// 5. Resumen Telegram
async function resumenTelegram(_p?: Record<string, any>) {
  const hoy = todayART();
  const { data: mepRow } = await sb.from("mep_historico").select("mep").eq("fecha", hoy).limit(1);
  const { data: cclRow } = await sb.from("dolar_historico").select("close").eq("fecha", hoy).eq("tipo", "ccl").limit(1);
  const { data: ofiRow } = await sb.from("dolar_historico").select("close").eq("fecha", hoy).eq("tipo", "oficial").limit(1);
  const mep = mepRow?.[0]?.mep;
  const ccl = cclRow?.[0]?.close;
  const ofi = ofiRow?.[0]?.close;
  await tgSend(`🏛️ <b>Resumen Diario — ${hoy}</b>\nMEP: <b>$${mep ?? "N/A"}</b>\nCCL: <b>$${ccl ?? "N/A"}</b>\nOficial: <b>$${ofi ?? "N/A"}</b>`);
  return { ok: true, mep, ccl, ofi };
}

// 6. Earnings Watch
async function earningsWatch(_p?: Record<string, any>) {
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
      if (e > now && e < horizon) alerts.push(`📅 ${sym}: earnings ${new Date(e * 1000).toISOString().slice(0, 10)}`);
    }
  }
  if (alerts.length) await tgSend(`📊 <b>Earnings Próximos</b>\n${alerts.join("\n")}`);
  return { ok: true, alerts: alerts.length };
}

// 7. Health check
async function healthCheck(_p?: Record<string, any>) {
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
async function historicoRefresh(_p?: Record<string, any>) {
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
    try {
      const r = await fetch(`${SB_URL}/functions/v1/fetch-historical`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
        body: JSON.stringify({ symbols: syms.slice(i, i + BATCH), from, to, persist: true }),
      });
      const d = await r.json();
      totalRows += d._persist?.inserted || 0;
    } catch (_) {}
  }
  return { ok: true, from, to, total_rows: totalRows };
}

type TaskFn = (params?: Record<string, any>) => Promise<any>;

const TASKS: Record<string, TaskFn> = {
  "watchdog-ars":      watchdogArs,
  "watchdog-usa":      watchdogUsa,
  "dolar-snapshot":    dolarSnapshot,
  "pnl-snapshot":      pnlSnapshot,
  "resumen-telegram":  resumenTelegram,
  "earnings-watch":    earningsWatch,
  "health-check":      healthCheck,
  "historico-refresh": historicoRefresh,
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json();
    const { task, ...taskParams } = body;
    const handler = TASKS[task];
    if (!handler) {
      return new Response(
        JSON.stringify({ error: `Unknown task: ${task}`, available: Object.keys(TASKS) }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }
    const result = await handler(taskParams);
    return new Response(JSON.stringify({ task, ...result }),
      { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});