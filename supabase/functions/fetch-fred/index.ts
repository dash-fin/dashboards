import { createClient } from 'jsr:@supabase/supabase-js@2';

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

const SERIES: Record<string, { display: string; unit: string; description: string }> = {
  DFF:            { display: 'Fed Funds Rate',        unit: '%',       description: 'Tasa de fondos federales efectiva' },
  DGS10:          { display: 'Treasury 10Y',           unit: '%',       description: 'Rendimiento bono USA 10 años' },
  DGS2:           { display: 'Treasury 2Y',            unit: '%',       description: 'Rendimiento bono USA 2 años' },
  T10YIE:         { display: 'Inflación esperada 10Y', unit: '%',       description: 'Breakeven inflation 10 años' },
  CPIAUCSL:       { display: 'CPI USA',                unit: 'índice',  description: 'Consumer Price Index' },
  UNRATE:         { display: 'Desempleo USA',          unit: '%',       description: 'Tasa de desempleo' },
  UMCSENT:        { display: 'Confianza consumidor',   unit: 'índice',  description: 'U. Michigan Consumer Sentiment' },
  BAMLEMARPITRIV: { display: 'Riesgo País Argentina',  unit: 'puntos',  description: 'EMBI+ Argentina' },
};

const SERIES_IDS = Object.keys(SERIES);

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    });
  }

  const FRED_API_KEY = Deno.env.get('FRED_API_KEY');
  if (!FRED_API_KEY) {
    return new Response(JSON.stringify({ error: 'FRED_API_KEY not set' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const SB_URL  = Deno.env.get('SUPABASE_URL')!;
  const SB_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const sb      = createClient(SB_URL, SB_KEY);

  // Parse optional body for mode override
  let mode: 'backfill' | 'refresh' | 'auto' = 'auto';
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.mode === 'backfill') mode = 'backfill';
    if (body?.mode === 'refresh')  mode = 'refresh';
  } catch (_) { /* ignore */ }

  const results: Record<string, { ok: boolean; rows?: number; error?: string }> = {};

  for (const seriesId of SERIES_IDS) {
    try {
      // Check if we have existing data
      const { data: existing, error: existErr } = await sb
        .from('cache_fred')
        .select('last_updated, data')
        .eq('series_id', seriesId)
        .maybeSingle();

      if (existErr) throw new Error(existErr.message);

      // Determine date range
      const today = new Date();
      let observationStart: string;

      const isBackfill = mode === 'backfill' || (mode === 'auto' && !existing);
      if (isBackfill) {
        // 5 years back
        const fiveYearsAgo = new Date(today);
        fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
        observationStart = fiveYearsAgo.toISOString().slice(0, 10);
      } else {
        // Incremental: last 30 days
        const thirtyDaysAgo = new Date(today);
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        observationStart = thirtyDaysAgo.toISOString().slice(0, 10);
      }

      const observationEnd = today.toISOString().slice(0, 10);

      // Fetch from FRED
      const url = new URL(FRED_BASE);
      url.searchParams.set('series_id', seriesId);
      url.searchParams.set('api_key', FRED_API_KEY);
      url.searchParams.set('file_type', 'json');
      url.searchParams.set('observation_start', observationStart);
      url.searchParams.set('observation_end', observationEnd);
      url.searchParams.set('sort_order', 'asc');

      const resp = await fetch(url.toString(), {
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        throw new Error(`FRED HTTP ${resp.status} for ${seriesId}`);
      }

      const json = await resp.json();
      const observations: Array<{ date: string; value: string }> = json.observations ?? [];

      // Filter out missing values ('.')
      const clean = observations
        .filter(o => o.value !== '.' && o.value !== '')
        .map(o => ({ date: o.date, value: parseFloat(o.value) }));

      if (!clean.length) {
        results[seriesId] = { ok: true, rows: 0 };
        continue;
      }

      // Merge with existing data if incremental
      let merged = clean;
      if (!isBackfill && existing?.data) {
        const existingData: Array<{ date: string; value: number }> = existing.data;
        const newDates = new Set(clean.map(o => o.date));
        const kept = existingData.filter(o => !newDates.has(o.date));
        merged = [...kept, ...clean].sort((a, b) => a.date.localeCompare(b.date));
      }

      // Compute spread 10Y-2Y if this is DGS10 or DGS2 — stored separately after both are fetched
      const meta = {
        ...SERIES[seriesId],
        series_id: seriesId,
        observation_start: observationStart,
        observation_end: observationEnd,
        count: merged.length,
        fetched_at: new Date().toISOString(),
      };

      const { error: upsertErr } = await sb
        .from('cache_fred')
        .upsert(
          {
            series_id: seriesId,
            data: merged,
            last_updated: new Date().toISOString(),
            metadata: meta,
          },
          { onConflict: 'series_id' }
        );

      if (upsertErr) throw new Error(upsertErr.message);

      results[seriesId] = { ok: true, rows: merged.length };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results[seriesId] = { ok: false, error: msg };
      console.error(`[fetch-fred] ${seriesId}:`, msg);
    }
  }

  // Compute and store spread 10Y-2Y
  try {
    const { data: dgs10Row } = await sb.from('cache_fred').select('data').eq('series_id', 'DGS10').maybeSingle();
    const { data: dgs2Row  } = await sb.from('cache_fred').select('data').eq('series_id', 'DGS2').maybeSingle();

    if (dgs10Row?.data && dgs2Row?.data) {
      const map2: Record<string, number> = {};
      (dgs2Row.data as Array<{ date: string; value: number }>).forEach(o => { map2[o.date] = o.value; });

      const spread = (dgs10Row.data as Array<{ date: string; value: number }>)
        .filter(o => map2[o.date] !== undefined)
        .map(o => ({ date: o.date, value: parseFloat((o.value - map2[o.date]).toFixed(4)) }));

      if (spread.length) {
        await sb.from('cache_fred').upsert(
          {
            series_id: 'SPREAD_10Y2Y',
            data: spread,
            last_updated: new Date().toISOString(),
            metadata: {
              display: 'Spread 10Y-2Y',
              unit: '%',
              description: 'Diferencial de rendimiento 10Y menos 2Y (curva de rendimiento)',
              series_id: 'SPREAD_10Y2Y',
              count: spread.length,
              fetched_at: new Date().toISOString(),
            },
          },
          { onConflict: 'series_id' }
        );
        results['SPREAD_10Y2Y'] = { ok: true, rows: spread.length };
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results['SPREAD_10Y2Y'] = { ok: false, error: msg };
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
});
