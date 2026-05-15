#!/usr/bin/env node
/**
 * supastock — Cotizaciones históricas vía Supabase
 * Uso: SR_KEY=sb_secret_... node supastock.js SYMBOL [desde] [hasta]
 */
const https = require('https');
const SR_KEY = process.env.SR_KEY;
if (!SR_KEY) {
  console.error('Error: SR_KEY environment variable required');
  console.error('  SR_KEY=sb_secret_... node supastock.js AAPL 2020-01-01');
  process.exit(1);
}
const [,, symArg, fromArg, toArg] = process.argv;
if (!symArg) { console.error('Uso: node supastock.js <SYMBOL> [desde] [hasta]'); process.exit(1); }
const symbols = symArg.split(',').map(s => s.trim().toUpperCase());
const from = fromArg || '2020-01-01';
const to = toArg || new Date().toISOString().slice(0, 10);
const body = JSON.stringify({ symbols, from, to });
const opts = {
  hostname: 'endymbpdayeidromxayb.supabase.co',
  path: '/functions/v1/fetch-historical',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'apikey': SR_KEY, 'Authorization': 'Bearer ' + SR_KEY },
};
const req = https.request(opts, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      for (const sym of symbols) {
        const rows = json[sym];
        if (!rows || !rows.length) { console.log(`\n${sym}: Sin datos`); continue; }
        const closes = rows.map(r => r.close);
        const max = Math.max(...closes);
        const min = Math.min(...closes);
        const avg = closes.reduce((a,b) => a+b, 0) / closes.length;
        const chg = ((rows[rows.length-1].close - rows[0].close) / rows[0].close * 100).toFixed(1);
        console.log(`\n${sym} · ${rows.length} registros`);
        console.log(`  ${rows[0].fecha} → ${rows[rows.length-1].fecha}`);
        console.log(`  Ult: $${rows[rows.length-1].close.toFixed(2)}  Max: $${max.toFixed(2)}  Min: $${min.toFixed(2)}  Var: ${chg>0?'+':''}${chg}%`);
        console.log(`  Ultimos 5:`);
        for (const r of rows.slice(-5)) console.log(`  • ${r.fecha}: $${r.close.toFixed(2)}`);
      }
    } catch (e) { console.error('Error:', data.slice(0,200)); }
  });
});
req.on('error', e => console.error(e.message));
req.write(body); req.end();
