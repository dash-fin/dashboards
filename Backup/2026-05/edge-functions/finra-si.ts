// ═══ finra-si/index.ts ═══
// ══════════════════════════════════════════════════════════════════
// Supabase Edge Function: finra-si
// FINRA Short Interest — cache + consulta por ticker
//
// Fuente: https://cdn.finra.org/equity/otcmarket/biweekly/shrt{YYYYMMDD}.csv
// Publicación: cada ~14 días (día 14-15 y último día hábil del mes)
// Formato: pipe-delimited CSV (~2MB, ~12k tickers)
// Sin API key ni autenticación
//
// Cache: guarda el CSV completo parseado como JSON en una tabla
// `cache_finra_si`. Un renglón = un settlement date, con el contenido
// completo del archivo. Se refresca automáticamente cuando detecta
// que pasaron 14+ días desde el último settlementDate cacheado.
//
// Endpoint:
//   POST { ticker: "GGAL" }
//   Response: {
//     ticker, issueName, marketClass, settlementDate,
//     currentShortPosition, previousShortPosition, changePercent,
//     changePreviousNumber, avgDailyVolume, daysToCover
//   }
//
// Fechas confirmadas (200+: desde 2020 hasta presente):
// Ver zyyzx/si-dashboard para lista completa.
// Última disponible: 2026-04-15
// ══════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

const FINRA_BASE = "https://cdn.finra.org/equity/otcmarket/biweekly/shrt";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── Fechas de settlement conocidas ────────────────────────────────
// Formato YYYYMMDD. La función intenta la más reciente ≤ hoy.
// Si falla, prueba con la anterior (el mismo script de zyyzx/si-dashboard
// itera en orden cronológico y saltea las que dan 403).
const SETTLEMENT_DATES = [
  "20260415", "20260430", "20260515", "20260529", "20260615", "20260630",
  "20260715", "20260731", "20260814", "20260831", "20260915", "20260930",
  "20261015", "20261030", "20261113", "20261130", "20261215", "20261231",
  "20250115","20250131","20250214","20250228","20250314","20250331",
  "20250415","20250430","20250515","20250530","20250613","20250630",
  "20250715","20250731","20250815","20250829","20250915","20250930",
  "20251015","20251031","20251114","20251128","20251215","20251231",
  "20240112","20240131","20240215","20240229","20240315","20240328",
  "20240415","20240430","20240515","20240531","20240614","20240628",
  "20240715","20240731","20240815","20240830","20240913","20240930",
  "20241015","20241031","20241115","20241129","20241213","20241231",
  "20230113","20230131","20230215","20230228","20230315","20230331",
  "20230414","20230428","20230515","20230531","20230615","20230630",
  "20230714","20230731","20230815","20230831","20230915","20230929",
  "20231013","20231031","20231115","20231130","20231215","20231229",
  "20220114","20220131","20220215","20220228","20220315","20220331",
  "20220414","20220429","20220513","20220531","20220615","20220630",
  "20220715","20220729","20220815","20220831","20220915","20220930",
  "20221014","20221031","20221115","20221130","20221215","20221230",
];

// ── Helpers ───────────────────────────────────────────────────────

function getSbClient(): ReturnType<typeof createClient> {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return createClient(url, key);
}

/** Devuelve las fechas de settlement más recientes (hasta count). */
function getLatestDates(count = 3): string[] {
  const today = new Date();
  const yyyymmdd = today.getFullYear().toString() +
    String(today.getMonth() + 1).padStart(2, "0") +
    String(today.getDate()).padStart(2, "0");
  return SETTLEMENT_DATES
    .filter(d => d <= yyyymmdd)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, count);
}

/** Descarga un archivo shrt y lo parsea a array de objetos. */
async function downloadFinra(dateStr: string): Promise<any[]> {
  const url = `${FINRA_BASE}${dateStr}.csv`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    throw new Error(`FINRA HTTP ${resp.status} para ${dateStr}`);
  }
  const text = await resp.text();
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split("|");
  const rows: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split("|");
    if (vals.length !== headers.length) continue;
    const row: any = {};
    headers.forEach((h, idx) => {
      row[h] = vals[idx];
    });
    rows.push(row);
  }
  return rows;
}

// ── Handler principal ─────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    const body: { ticker?: string } = await req.json();
    const ticker = (body.ticker ?? "").toUpperCase().trim();
    if (!ticker) {
      return new Response(JSON.stringify({ error: "Se requiere campo 'ticker'" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const sb = getSbClient();
    const latestDates = getLatestDates(5); // probar hasta 5 fechas atrás
    let cacheHit = false;
    let settlementDate = "";
    let rows: any[] = [];

    // 1. Buscar en cache de Supabase
    for (const d of latestDates) {
      const { data, error } = await sb
        .from("cache_finra_si")
        .select("settlement_date, data")
        .eq("settlement_date", d)
        .maybeSingle();
      if (data && !error) {
        const cached = data as { settlement_date: string; data: any[] };
        settlementDate = cached.settlement_date;
        rows = cached.data;
        cacheHit = true;
        break;
      }
    }

    // 2. Si no hay cache, descargar de FINRA
    if (!cacheHit) {
      const dateToTry = latestDates[0];
      if (!dateToTry) {
        return new Response(JSON.stringify({ error: "No hay fechas disponibles" }), {
          status: 404, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      // Intentar descargar, si falla probar fechas anteriores
      let downloaded = false;
      for (const d of latestDates) {
        try {
          rows = await downloadFinra(d);
          settlementDate = d;
          downloaded = true;
          console.log(`FINRA: descargado shrt${d}.csv (${rows.length} tickers)`);
          break;
        } catch (e) {
          console.log(`FINRA: ${d} no disponible (${e.message})`);
        }
      }

      if (!downloaded) {
        return new Response(JSON.stringify({ error: "No se pudo descargar datos FINRA" }), {
          status: 502, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      // Guardar en cache (insert o update)
      const { error: upsertErr } = await sb
        .from("cache_finra_si")
        .upsert(
          { settlement_date: settlementDate, data: rows, updated_at: new Date().toISOString() },
          { onConflict: "settlement_date" }
        );
      if (upsertErr) {
        console.error("Error guardando cache:", upsertErr.message);
      } else {
        console.log(`FINRA: cache guardado para ${settlementDate}`);
      }
    }

    // 3. Buscar el ticker en los datos
    const match = rows.find((r: any) =>
      r.symbolCode?.toUpperCase() === ticker
    );

    if (!match) {
      return new Response(JSON.stringify({
        ticker,
        settlementDate,
        found: false,
        message: "Ticker no encontrado en short interest",
      }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // 4. Armar respuesta
    const result = {
      ticker: match.symbolCode,
      issueName: match.issueName,
      marketClass: match.marketClassCode,
      settlementDate: match.settlementDate || settlementDate,
      currentShortPosition: Number(match.currentShortPositionQuantity) || 0,
      previousShortPosition: Number(match.previousShortPositionQuantity) || 0,
      changePercent: Number(match.changePercent) || 0,
      changePreviousNumber: Number(match.changePreviousNumber) || 0,
      avgDailyVolume: Number(match.averageDailyVolumeQuantity) || 0,
      daysToCover: Number(match.daysToCoverQuantity) || 0,
      cacheHit,
      found: true,
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (e: any) {
    console.error("finra-si error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
