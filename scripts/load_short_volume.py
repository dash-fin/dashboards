#!/usr/bin/env python3
"""
Carga Short Volume a Supabase via Management API SQL (evita REST 409).
Parser más rápido: solo carga los últimos 60 días hábiles.
"""
import os, json, urllib.request, urllib.error, time
from datetime import date, timedelta

TOKEN = "sbp_70ca5c99aca15dc12d9229f032ff08739385c285"
MGMT_URL = "https://api.supabase.com/v1/projects/endymbpdayeidromxayb/database/query"
FINRA_DIR = "/mnt/c/dashboard/Github/FINRA/short_volume/CNMS"

os.nice(19)

def sql(query):
    data = json.dumps({"query": query}).encode()
    req = urllib.request.Request(MGMT_URL, data=data, method="POST")
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        err = e.read().decode()[:300]
        print(f"  SQL Error {e.code}: {err}")
        return None

def parse_cnms(filepath):
    rows = []
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            lines = f.readlines()
        fname = os.path.basename(filepath)
        ds = fname.replace("CNMSshvol", "").replace(".txt", "")
        ymd = f"{ds[:4]}-{ds[4:6]}-{ds[6:8]}"
        for i, line in enumerate(lines):
            if i == 0: continue
            parts = line.strip().split("|")
            if len(parts) < 6: continue
            sym = parts[1].strip().upper()
            if not sym or len(sym) > 5: continue
            sv = int(parts[2].replace(",","")) if parts[2].strip() else 0
            tv = int(parts[4].replace(",","")) if parts[4].strip() else 0
            if tv == 0: continue
            mkt = parts[5].strip()
            rows.append((ymd, sym, sv, tv, mkt))
        return rows
    except Exception as e:
        print(f"  Error {filepath}: {e}")
        return []

# Build values for SQL INSERT
files = sorted(os.listdir(FINRA_DIR))
recent = files[-120:]  # ~60 weekdays
total = 0

print(f"Cargando {len(recent)} archivos via SQL upsert...")
start = time.time()

for idx, fname in enumerate(recent):
    if not fname.endswith(".txt"): continue
    rows = parse_cnms(os.path.join(FINRA_DIR, fname))
    if not rows: continue
    
    # Build multi-row VALUES
    vals = ", ".join(
        f"('{r[0]}','{r[1]}',{r[2]},{r[3]},'{r[4]}')" for r in rows
    )
    
    query = f"""INSERT INTO cache_finra_short_volume 
(trade_date, ticker, short_volume, total_volume, market)
VALUES {vals}
ON CONFLICT (ticker, trade_date, market) DO NOTHING;"""
    
    r = sql(query)
    total += len(rows)
    
    if (idx + 1) % 20 == 0:
        elapsed = time.time() - start
        print(f"  {idx+1}/{len(recent)} | {total} filas | {total/elapsed:.0f}/s")
    
    time.sleep(0.05)

elapsed = time.time() - start
print(f"\n✅ Hecho: {total} filas en {elapsed:.0f}s")
