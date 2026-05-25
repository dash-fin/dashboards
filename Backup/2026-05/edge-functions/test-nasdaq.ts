// ═══ test-nasdaq/index.ts ═══
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

serve(async (req) => {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
    "Referer": "https://data.nasdaq.com/",
  };

  const url = "https://data.nasdaq.com/api/v3/datasets/NSS/GGAL.json?api_key=TxAfzSQx9Fp81ysgex92&rows=5";
  
  try {
    const resp = await fetch(url, { headers });
    const text = await resp.text();
    return new Response(JSON.stringify({ 
      status: resp.status, 
      ok: resp.ok,
      body: text.substring(0, 500),
      headers: Object.fromEntries(resp.headers.entries()),
    }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    });
  }
});
