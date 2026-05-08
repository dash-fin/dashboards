"""
Backfill: carga pnl_diario para días hábiles faltantes.
Usa el mismo algoritmo que pfBackfillPnL() en portafolio.html pero desde Python.

Uso:
    python backfill_pnl.py [fecha_desde] [fecha_hasta]
    
    Si no se pasan fechas, detecta automáticamente días faltantes hasta hoy.
"""
import urllib.request, json, ssl, sys
from datetime import date, timedelta
from urllib.error import HTTPError

SB_URL = "https://endymbpdayeidromxayb.supabase.co"
SR_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVuZHltYnBkYXllaWRyb214YXliIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzUzNTg1MCwiZXhwIjoyMDg5MTExODUwfQ.gvdEDz-4YPM8zvgR94EUv6JBpTNdR8u5G4EM3j3NSpI"
ssl_ctx = ssl.create_default_context()

def sb_get(table, params=""):
    url = f"{SB_URL}/rest/v1/{table}?{params}"
    req = urllib.request.Request(url, headers={"apikey": SR_KEY, "Accept": "application/json"})
    with urllib.request.urlopen(req, context=ssl_ctx) as r:
        return json.loads(r.read())

def sb_upsert(table, rows):
    """Upsert en lotes de 100"""
    for i in range(0, len(rows), 100):
        batch = rows[i:i+100]
        body = json.dumps(batch).encode()
        url = f"{SB_URL}/rest/v1/{table}"
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "apikey": SR_KEY,
            "Authorization": f"Bearer {SR_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        })
        with urllib.request.urlopen(req, context=ssl_ctx) as r:
            print(f"  Lote {i//100+1}: HTTP {r.status} ({len(batch)} filas)")

BONOS = ['BONO_SOBERANO','DOLAR_LINKED','BONO_CER','BONO_DUAL']

def is_business_day(d):
    return d.weekday() < 5  # 0=Monday..4=Friday

def main():
    # Email del usuario
    email = "esperonjuanmanuel@gmail.com"
    
    # 1. Posiciones activas + trades cerrados
    print("📦 Cargando posiciones...")
    pos_rows = sb_get("portafolio", "activo=eq.true&tipo=neq.OPCION&select=ticker_ars,tipo,cantidad,fecha_compra")
    trade_rows = sb_get("trades", f"user_email=eq.{email}&select=ticker_ars,tipo,cantidad,fecha,fecha_cierre")
    
    today = date.today().isoformat()
    all_pos = []
    for p in pos_rows:
        all_pos.append({
            "ticker": p["ticker_ars"], "tipo": p["tipo"],
            "qty": float(p["cantidad"]), "open": p["fecha_compra"], "close": today,
        })
    for t in trade_rows:
        if t.get("tipo") == "OPCION": continue
        all_pos.append({
            "ticker": t["ticker_ars"], "tipo": t["tipo"],
            "qty": float(t["cantidad"]), "open": t["fecha"],
            "close": t.get("fecha_cierre") or today,
        })
    all_pos = [p for p in all_pos if p["ticker"] and p["qty"] > 0 and p["open"]]
    print(f"  {len(all_pos)} posiciones activas/cerradas")
    
    if not all_pos:
        print("❌ Sin posiciones")
        return
    
    start_date = min(p["open"] for p in all_pos)
    
    # 2. Días ya guardados
    print("📆 Verificando días existentes...")
    existing = sb_get("pnl_diario", f"fecha=gte.{start_date}&select=fecha,valor_usd")
    existing_set = {r["fecha"] for r in existing}
    # También cargar existentes para calcular delta
    all_known = {r["fecha"]: float(r["valor_usd"]) for r in existing}
    
    print(f"  {len(existing)} días ya registrados")
    
    # 3. Precios Rava history y MEP
    print("📈 Cargando precios históricos...")
    tickers = list(set(p["ticker"] for p in all_pos))
    
    # Yahoo-prices edge function para Rava series
    edge_headers = {
        "Content-Type": "application/json",
        "apikey": SR_KEY,
        "Authorization": f"Bearer {SR_KEY}",
    }
    body = json.dumps({"mode": "rava-series", "symbols": tickers}).encode()
    req = urllib.request.Request(
        f"{SB_URL}/functions/v1/yahoo-prices",
        data=body, method="POST", headers=edge_headers,
    )
    req.add_header("Content-Type", "application/json")  # Deno edge function expects this
    try:
        with urllib.request.urlopen(req, context=ssl_ctx) as r:
            series_resp = json.loads(r.read())
    except HTTPError as e:
        print(f"  ⚠️ Error edge function: {e.code} - {e.read().decode()[:200]}")
        # Fallback: si falla, usamos datos existentes de mercado_usa_history
        
        # Intentar con yahoo-history mode
        fallback_body = json.dumps({
            "mode": "yahoo-history", "symbols": ["SPY"], "startDate": start_date
        }).encode()
        req2 = urllib.request.Request(
            f"{SB_URL}/functions/v1/yahoo-prices",
            data=fallback_body, method="POST", headers=edge_headers,
        )
        with urllib.request.urlopen(req2, context=ssl_ctx) as r2:
            series_resp = json.loads(r2.read())
            print(f"  Usando yahoo-history mode como fallback")
    
    # Precios por ticker por fecha
    price_by_tk = {}
    for tk, rows in (series_resp or {}).items():
        price_by_tk[tk] = {}
        for r in (rows or []):
            price_by_tk[tk][r["fecha"]] = r.get("cierre") or r.get("close") or r.get("last")
    
    print(f"  Precios cargados para {len(price_by_tk)} tickers")
    
    # MEP histórico
    print("💰 Cargando MEP histórico...")
    mep_rows = sb_get("mep_historico", f"fecha=gte.{start_date}&order=fecha.asc&select=fecha,mep")
    mep_by_date = {r["fecha"]: float(r["mep"]) for r in mep_rows if r.get("mep")}
    print(f"  {len(mep_by_date)} días con MEP")
    
    def closest_before(map_obj, d):
        keys = sorted([k for k in map_obj.keys() if k <= d])
        return map_obj[keys[-1]] if keys else None
    
    # 4. Determinar días a calcular
    # Días hábiles desde el último día conocido hasta hoy
    known_dates = sorted(all_known.keys())
    last_known = known_dates[-1] if known_dates else start_date
    last_dt = date.fromisoformat(last_known)
    
    # Si hay fechas pasadas por CLI, usarlas
    args = sys.argv[1:]
    if len(args) >= 1:
        desde = args[0]
        hasta = args[1] if len(args) >= 2 else today
    else:
        # Auto-detectar: desde el día siguiente al último conocido
        desde = (last_dt + timedelta(days=1)).isoformat()
        hasta = today
    
    print(f"\n🔍 Rango: {desde} → {hasta}")
    
    # Generar días hábiles a procesar
    d = date.fromisoformat(desde)
    end = date.fromisoformat(hasta)
    dates_to_process = []
    while d <= end:
        ds = d.isoformat()
        if is_business_day(d) and ds not in existing_set:
            dates_to_process.append(ds)
        d += timedelta(days=1)
    
    print(f"  {len(dates_to_process)} días hábiles a procesar")
    
    if not dates_to_process:
        print("✅ Nada que hacer — todos los días ya están cargados")
        return
    
    # 5. Calcular valor USD por fecha
    to_insert = []
    for ds in dates_to_process:
        mep = mep_by_date.get(ds) or closest_before(mep_by_date, ds)
        if not mep or mep <= 0:
            print(f"  ⏭️ {ds}: sin MEP (usando último conocido)")
            mep = closest_before(mep_by_date, ds)
            if not mep or mep <= 0:
                print(f"  ⏭️ {ds}: sin MEP disponible, skip")
                continue
        
        total_usd = 0
        has_px = False
        for p in all_pos:
            if p["open"] > ds or p["close"] < ds:
                continue
            px = closest_before(price_by_tk.get(p["ticker"]) or {}, ds)
            if not px:
                continue
            factor = 100 if p["tipo"] in BONOS else 1
            total_usd += (p["qty"] * px) / (factor * mep)
            has_px = True
        
        if not has_px or total_usd <= 0:
            print(f"  ⏭️ {ds}: sin precios para posiciones, skip")
            continue
        
        to_insert.append({"fecha": ds, "valor_usd": round(total_usd, 2)})
        print(f"  ✓ {ds}: U$S {round(total_usd):,}")
    
    if not to_insert:
        print("❌ No se pudo calcular ningún día")
        return
    
    # 6. Calcular pnl_usd / pnl_pct
    combined = dict(all_known)
    for r in to_insert:
        combined[r["fecha"]] = r["valor_usd"]
    sorted_all = sorted(combined.keys())
    
    final_rows = []
    for row in to_insert:
        idx = sorted_all.index(row["fecha"])
        prev = combined.get(sorted_all[idx-1]) if idx > 0 else None
        pnl_usd = round(row["valor_usd"] - prev, 2) if prev else None
        pnl_pct = round((row["valor_usd"] - prev) / prev * 100, 4) if prev and prev > 0 else None
        final_rows.append({
            "fecha": row["fecha"],
            "valor_usd": row["valor_usd"],
            "pnl_usd": pnl_usd,
            "pnl_pct": pnl_pct,
        })
    
    # 7. Upsert
    print(f"\n💾 Insertando {len(final_rows)} filas en pnl_diario...")
    sb_upsert("pnl_diario", final_rows)
    print("✅ Backfill completado")


if __name__ == "__main__":
    main()
