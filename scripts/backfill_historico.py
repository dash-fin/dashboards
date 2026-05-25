#!/usr/bin/env python3
"""
backfill_historico.py — Llena historico_precios con 5 anos de datos
para los 560 simbolos de mercado_usa, usando fetch-historical persist:true.
"""
import json, urllib.request, urllib.error, time, sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

SB_URL = "https://endymbpdayeidromxayb.supabase.co"
SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVuZHltYnBkYXllaWRyb214YXliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MzU4NTAsImV4cCI6MjA4OTExMTg1MH0.BCZRvE9F1g_w2ffwj6NA6vyCYab2XcHDgmZir3CkeOk"
HDR = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}", "Content-Type": "application/json"}

FROM = (datetime.utcnow() - timedelta(days=365 * 5)).strftime("%Y-%m-%d")
TO   = datetime.utcnow().strftime("%Y-%m-%d")
BATCH = 5
WORKERS = 6

def get_universe():
    req = urllib.request.Request(
        SB_URL + "/rest/v1/mercado_usa?select=symbol&order=symbol.asc",
        headers={"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        rows = json.loads(r.read())
    return [x["symbol"] for x in rows]

def fetch_batch(symbols):
    body = json.dumps({"symbols": symbols, "from": FROM, "to": TO, "persist": True}).encode()
    req = urllib.request.Request(SB_URL + "/functions/v1/fetch-historical", data=body, headers=HDR, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            data = json.loads(r.read())
        rows = sum(len(v) for v in data.values() if isinstance(v, list))
        return rows, 0
    except urllib.error.HTTPError as e:
        return 0, e.code
    except Exception as e:
        return 0, -1

def main():
    print("FROM:", FROM, "TO:", TO)
    syms = get_universe()
    print("Universe:", len(syms), "symbols")
    batches = [syms[i:i+BATCH] for i in range(0, len(syms), BATCH)]
    print("Batches:", len(batches), "size", BATCH, "workers", WORKERS); print()
    t0 = time.time(); done = 0; total = 0; errors = []
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(fetch_batch, b): b for b in batches}
        for fut in as_completed(futs):
            b = futs[fut]
            rows, err = fut.result()
            done += 1; total += rows
            if err != 0: errors.append((b, err))
            elapsed = time.time() - t0
            eta = (elapsed / done) * (len(batches) - done) if done else 0
            tag = "ok" if err == 0 else "ERR " + str(err)
            print("  [", done, "/", len(batches), "]", ",".join(b)[:40], "rows=", rows, tag, "ETA", int(eta), "s", flush=True)
    print()
    print("Done in", int(time.time()-t0), "s")
    print("Total rows:", total)
    if errors:
        print("Errors:", len(errors))
        for b, e in errors[:10]:
            print(" ", b, "HTTP", e)

if __name__ == "__main__":
    main()
