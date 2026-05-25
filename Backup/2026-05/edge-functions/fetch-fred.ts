// ═══ fetch-fred/index.ts ═══
import { createClient } from 'jsr:@supabase/supabase-js@2';

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

const SERIES: Record<string, { display: string; unit: string; desc: string }> = {
  DFF:            { display: 'Fed Funds Rate',        unit: '%',      desc: 'Tasa de fondos federales efectiva' },
  DGS10:          { display: 'Treasury 10Y',           unit: '%',      desc: 'Rendimiento bono USA 10 años' },
  DGS2:           { display: 'Treasury 2Y',            unit: '%',      desc: 'Rendimiento bono USA 2 años' },
  T10YIE:         { display: 'Inflación esperada 10Y', unit: '%',      desc: 'Breakeven inflation 10 años' },
  CPIAUCSL:       { display: 'CPI USA',                unit: 'índice', desc: 'Consumer Price Index' },
  UNRATE:         { display: 'Desempleo USA',          unit: '%',      desc: 'Tasa de desempleo' },
  UMCSENT:        { display: 'Confianza consumidor',   unit: 'índice', desc: 'U. of Michigan Consumer Sentiment' },
//BAMLEMARPITRIV: { display: 'Riesgo País Argentina',  unit: 'puntos', desc: 'EMBI+ Argentina — descontinuada en FRED' },
};

const RECESSION_DATES = [
  { start: '1948-10-01', end: '1949-10-01' },
  { start: '1953-07-01', end: '1954-05-01' },
  { start: '1957-08-01', end: '1958-04-01' },
  { start: '1960-04-01', end: '1961-02-01' },
  { start: '1969-12-01', end: '1970-11-01' },
  { start: '1973-11-01', end: '1975-03-01' },
  { start: '1980-01-01', end: '1980-07-01' },
  { start: '1981-07-01', end: '1982-11-01' },
  { start: '1990-07-01', end: '1991-03-01' },
  { start: '2001-03-01', end: '2001-11-01' },
  { start: '2007-12-01', end: '2009-06-01' },
  { start: '2020-02-01', end: '2020-04-01' },
];

async function fetchFredSeries(
  seriesId: string,
  apiKey: string,
  observationStart: string,
  observationEnd: string
): Promise<Array<{ date: string; value: number | null }>> {
  const url = new URL(FRED_BASE);
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('observation_start', observationStart);
  url.searchParams.set('observation_end', observationEnd);
  url.searchParams.set('sort_order', 'asc');

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    throw new Error(`FRED API error for ${seriesId}: ${resp.status} ${resp.statusText}`);
  }
  const json = await resp.json();
  return (json.observations || []).map((o: { date: string; value: string }) => ({
    date: o.date,
    value: o.value === '.' ? null : parseFloat(o.value),
  }));
}

function calcSpread(
  dgs10: Array<{ date: string; value: number | null }>,
  dgs2: Array<{ date: string; value: number | null }>
): Array<{ date: string; value: number | null }> {
  const map2: Record<string, number | null> = {};
  dgs2.forEach(r => { map2[r.date] = r.value; });
  return dgs10.map(r => ({
    date: r.date,
    value: r.value != null && map2[r.date] != null ? r.value - map2[r.date]! : null,
  }));
}

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const fredApiKey  = Deno.env.get('FRED_API_KEY');

    if (!fredApiKey) {
      return new Response(
        JSON.stringify({ error: 'FRED_API_KEY env var not set' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const sb = createClient(supabaseUrl, supabaseKey);

    // Check if cache_fred table has any data (to decide backfill vs incremental)
    const { data: existingRows, error: checkErr } = await sb
      .from('cache_fred')
      .select('series_id, last_updated')
      .limit(20);

    if (checkErr) {
      console.error('cache_fred check error:', checkErr);
    }

    const existingMap: Record<string, string> = {};
    (existingRows || []).forEach((r: { series_id: string; last_updated: string }) => {
      existingMap[r.series_id] = r.last_updated;
    });

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    // Backfill: 5 years back; incremental: 30 days back
    const fiveYearsAgo = new Date(today);
    fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const results: Record<string, unknown> = {};
    const errors: Record<string, string> = {};

    for (const [seriesId, meta] of Object.entries(SERIES)) {
      try {
        const isNew = !existingMap[seriesId];
        const startDate = isNew
          ? fiveYearsAgo.toISOString().slice(0, 10)
          : thirtyDaysAgo.toISOString().slice(0, 10);

        console.log(`Fetching ${seriesId} from ${startDate} (${isNew ? 'backfill' : 'incremental'})`);

        const observations = await fetchFredSeries(seriesId, fredApiKey, startDate, todayStr);

        if (!observations.length) {
          console.warn(`No observations for ${seriesId}`);
          continue;
        }

        // If incremental, merge with existing data
        let finalData = observations;
        if (!isNew) {
          const { data: cached } = await sb
            .from('cache_fred')
            .select('data')
            .eq('series_id', seriesId)
            .single();

          if (cached?.data) {
            const existingObs: Array<{ date: string; value: number | null }> = cached.data;
            const existingDates = new Set(existingObs.map((o: { date: string }) => o.date));
            const newObs = observations.filter(o => !existingDates.has(o.date));
            finalData = [...existingObs, ...newObs].sort((a, b) => a.date.localeCompare(b.date));
          }
        }

        // Latest non-null value
        const latestObs = [...finalData].reverse().find(o => o.value != null);

        const upsertPayload = {
          series_id: seriesId,
          data: finalData,
          last_updated: new Date().toISOString(),
          metadata: {
            display: meta.display,
            unit: meta.unit,
            desc: meta.desc,
            latest_value: latestObs?.value ?? null,
            latest_date: latestObs?.date ?? null,
            count: finalData.length,
          },
        };

        const { error: upsertErr } = await sb
          .from('cache_fred')
          .upsert(upsertPayload, { onConflict: 'series_id' });

        if (upsertErr) {
          errors[seriesId] = upsertErr.message;
          console.error(`Upsert error for ${seriesId}:`, upsertErr);
        } else {
          results[seriesId] = {
            count: finalData.length,
            latest: latestObs,
            mode: isNew ? 'backfill' : 'incremental',
          };
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors[seriesId] = msg;
        console.error(`Error fetching ${seriesId}:`, msg);
      }
    }

    // Calculate and store spread 10Y-2Y
    try {
      const { data: dgs10Row } = await sb.from('cache_fred').select('data').eq('series_id', 'DGS10').single();
      const { data: dgs2Row  } = await sb.from('cache_fred').select('data').eq('series_id', 'DGS2').single();

      if (dgs10Row?.data && dgs2Row?.data) {
        const spreadData = calcSpread(dgs10Row.data, dgs2Row.data);
        const latestSpread = [...spreadData].reverse().find(o => o.value != null);

        await sb.from('cache_fred').upsert({
          series_id: 'SPREAD_10Y2Y',
          data: spreadData,
          last_updated: new Date().toISOString(),
          metadata: {
            display: 'Spread 10Y-2Y',
            unit: 'pp',
            desc: 'Diferencial de rendimiento 10Y menos 2Y (curva de rendimiento)',
            latest_value: latestSpread?.value ?? null,
            latest_date: latestSpread?.date ?? null,
            count: spreadData.length,
          },
        }, { onConflict: 'series_id' });

        results['SPREAD_10Y2Y'] = { count: spreadData.length, latest: latestSpread, mode: 'calculated' };
      }
    } catch (e) {
      errors['SPREAD_10Y2Y'] = e instanceof Error ? e.message : String(e);
    }

    // Store recession dates as a static series for chart shading
    try {
      await sb.from('cache_fred').upsert({
        series_id: 'RECESSION_DATES',
        data: RECESSION_DATES,
        last_updated: new Date().toISOString(),
        metadata: {
          display: 'Recesiones USA (NBER)',
          unit: 'fechas',
          desc: 'Períodos de recesión según NBER',
          latest_value: null,
          latest_date: null,
          count: RECESSION_DATES.length,
        },
      }, { onConflict: 'series_id' });
    } catch (e) {
      errors['RECESSION_DATES'] = e instanceof Error ? e.message : String(e);
    }

    return new Response(
      JSON.stringify({ ok: true, results, errors, timestamp: new Date().toISOString() }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('fetch-fred fatal error:', msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
