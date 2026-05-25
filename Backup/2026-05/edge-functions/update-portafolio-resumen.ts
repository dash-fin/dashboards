// ═══ update-portafolio-resumen/index.ts ═══
// ══════════════════════════════════════════════════════════════════
// Supabase Edge Function: update-portafolio-resumen
// Recalcula KPIs de portafolio (MEP, posiciones, opciones, trades)
// y hace UPSERT en portafolio_resumen + pnl_diario.
//
// Uso:
//   POST {} — recalcula todos los usuarios
//   POST { email: "user@x.com" } — recalcula solo ese usuario
//
// Llamado por:
//   - pg_cron cada 5 minutos
//   - portafolio.html / PortafolioScreen.js tras cada mutación
// ══════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "https://endymbpdayeidromxayb.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVuZHltYnBkYXllaWRyb214YXliIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzUzNTg1MCwiZXhwIjoyMDg5MTExODUwfQ.gvdEDz-4YPM8zvgR94EUv6JBpTNdR8u5G4EM3j3NSpI";

const H  = { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const UP = { ...H, "Prefer": "resolution=merge-duplicates,return=minimal" };

const BOND_TYPES = new Set(["BONO_SOBERANO", "DOLAR_LINKED", "BONO_CER", "BONO_DUAL"]);

async function get(path: string): Promise<any[]> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H });
  const d = await r.json();
  return Array.isArray(d) ? d : [];
}

async function post(path: string, body: unknown): Promise<void> {
  await fetch(`${SB_URL}/rest/v1/${path}`, { method: "POST", headers: UP, body: JSON.stringify(body) });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    let filterEmail: string | null = null;
    try {
      const body = await req.json();
      if (body?.email) filterEmail = body.email;
    } catch (_) { /* no body = recalculate all */ }

    // Today (UTC-3, Argentina)
    const nowAR    = new Date(Date.now() - 3 * 3600_000);
    const todayStr = nowAR.toISOString().slice(0, 10);
    const dow      = nowAR.getDay(); // 0=Sun, 6=Sat

    // MEP: AL30 / AL30D
    const mepRows = await get(`mercado?symbol=in.("AL30","AL30D")&settlement=eq.24hs&select=symbol,last`);
    const mepMap: Record<string, number> = {};
    for (const r of mepRows) mepMap[r.symbol] = parseFloat(r.last) || 0;
    const mep = mepMap["AL30D"] > 0 ? mepMap["AL30"] / mepMap["AL30D"] : 1440;

    // Active user emails
    const emailRows = await get(`portafolio?activo=eq.true&select=user_email`);
    let emails = [...new Set(emailRows.map((r: any) => r.user_email).filter(Boolean))] as string[];
    if (filterEmail) emails = emails.filter(e => e === filterEmail);

    for (const email of emails) {
      const enc = encodeURIComponent(email);

      // Non-option positions
      const positions = await get(`portafolio?user_email=eq.${enc}&activo=eq.true&tipo=neq.OPCION&select=ticker_ars,tipo,cantidad,precio_compra_ars,mep_compra,fecha_compra`);

      // Current prices
      const tickers = [...new Set(positions.map((p: any) => (p.ticker_ars || "").split(" ")[0]).filter(Boolean))];
      const priceMap: Record<string, any> = {};
      if (tickers.length > 0) {
        const inStr = tickers.map(t => `"${t}"`).join(",");
        const rows = await get(`mercado?symbol=in.(${inStr})&settlement=eq.24hs&select=symbol,last,change`);
        for (const r of rows) priceMap[r.symbol] = r;
      }

      let totalInv = 0, totalVal = 0, dailyPnl = 0;
      for (const p of positions) {
        const sym    = (p.ticker_ars || "").split(" ")[0];
        const factor = BOND_TYPES.has(p.tipo) ? 100 : 1;
        const mc     = parseFloat(p.mep_compra) || 0;
        const cant   = parseFloat(p.cantidad) || 0;
        const cpa    = parseFloat(p.precio_compra_ars) || 0;
        const cost   = mc > 0 ? cant * cpa / (factor * mc) : 0;
        const px     = priceMap[sym] || {};
        const last   = parseFloat(px.last) || 0;
        const val    = last > 0 ? cant * last / (factor * mep) : 0;
        totalInv += cost;
        totalVal += val;
        if (p.fecha_compra && p.fecha_compra < todayStr && px.change != null && val > 0) {
          dailyPnl += val * parseFloat(px.change) / 100;
        }
      }

      // Realized gains (trades)
      const trades = await get(`trades?user_email=eq.${enc}&select=ganancia_usd`);
      const realized = trades.reduce((s: number, r: any) => s + (parseFloat(r.ganancia_usd) || 0), 0);

      // Options P&L
      let opsPnl = 0, opsDaily = 0;
      const opPortRows = await get(`portafolio?user_email=eq.${enc}&activo=eq.true&tipo=eq.OPCION&select=operacion_id`);
      const opIds = opPortRows.map((r: any) => r.operacion_id).filter(Boolean);

      if (opIds.length > 0) {
        const idsStr = opIds.map((id: string) => `"${id}"`).join(",");
        const opsRows = await get(`operaciones?id=in.(${idsStr})&estado=eq.abierta&select=patas`);
        const allSyms = [...new Set(opsRows.flatMap((op: any) =>
          (op.patas || []).map((p: any) => p.symbol).filter(Boolean)
        ))] as string[];

        if (allSyms.length > 0) {
          const symStr = allSyms.map((s: string) => `"${s}"`).join(",");
          const optPxRows = await get(`opciones_rt?symbol=in.(${symStr})&select=symbol,last,previous_close`);
          const optPx: Record<string, any> = {};
          for (const r of optPxRows) optPx[r.symbol] = r;

          for (const op of opsRows) {
            for (const pata of (op.patas || [])) {
              const sym = pata.symbol;
              if (!optPx[sym]) continue;
              const sign = pata.action === "buy" ? 1 : -1;
              const prima = parseFloat(pata.prima) || 0;
              const qty   = parseInt(pata.qty) || 0;
              const sz    = parseInt(pata.option_size) || 100;
              const cur   = parseFloat(optPx[sym].last) || prima;
              const prev  = parseFloat(optPx[sym].previous_close) || cur;
              opsPnl   += sign * (cur - prima) * qty * sz / mep;
              opsDaily += sign * (cur - prev)  * qty * sz / mep;
            }
          }
        }
      }

      const totAct = totalVal + opsPnl;
      const pnlTot = (totalVal - totalInv) + opsPnl + realized;
      const pnlPct = totalInv > 0 ? pnlTot / totalInv * 100 : 0;
      const dayTot = dailyPnl + opsDaily;
      const dayPct = totAct > 0 ? dayTot / totAct * 100 : 0;
      const round2 = (n: number) => Math.round(n * 100) / 100;

      await post("portafolio_resumen", {
        user_email:         email,
        total_value_usd:    round2(totAct),
        total_invested_usd: round2(totalInv),
        pnl_total_usd:      round2(pnlTot),
        pnl_total_pct:      round2(pnlPct),
        pnl_diario_usd:     round2(dayTot),
        pnl_diario_pct:     round2(dayPct),
        updated_at:         new Date().toISOString(),
      });

      // pnl_diario — solo días hábiles con datos
      if (dow > 0 && dow < 6 && totAct > 0) {
        await post("pnl_diario", {
          user_email: email,
          fecha:      todayStr,
          valor_usd:  round2(totAct),
          pnl_usd:    round2(dayTot),
          pnl_pct:    round2(dayPct),
        });
      }
    }

    return new Response(JSON.stringify({ ok: true, updated: emails.length, emails }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
