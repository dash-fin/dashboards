"""
Seeder: carga el portafolio de Juan M. Esperon en Supabase.
Ejecutar DESPUÉS de crear la tabla con portafolio_table.sql

Uso:
    python portafolio_seed.py
"""
import urllib.request, json, ssl

SB_URL = "https://endymbpdayeidromxayb.supabase.co"
SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVuZHltYnBkYXllaWRyb214YXliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MzU4NTAsImV4cCI6MjA4OTExMTg1MH0.BCZRvE9F1g_w2ffwj6NA6vyCYab2XcHDgmZir3CkeOk"
USER  = "esperonjuanmanuel@gmail.com"

POSITIONS = [
    # ── DÓLAR LINKED ─────────────────────────────────────────────────────────
    # Fuente: INVERSIONES sheet → sección DOLAR LINKED
    # Ganancia en precio = Dolares actual - Dolares Invertidos (vía MEP)
    dict(user_email=USER, tipo="DOLAR_LINKED", ticker_ars="MRCAO", ticker_usd="MRCAD",
         fecha_compra="2025-05-15", cantidad=485,   precio_compra_ars=35100, mep_compra=1137.00),
    dict(user_email=USER, tipo="DOLAR_LINKED", ticker_ars="MRCAO", ticker_usd="MRCAD",
         fecha_compra="2025-05-15", cantidad=2000,  precio_compra_ars=35520, mep_compra=1143.38),
    dict(user_email=USER, tipo="DOLAR_LINKED", ticker_ars="MRCAO", ticker_usd="MRCAD",
         fecha_compra="2025-05-26", cantidad=298,   precio_compra_ars=30500, mep_compra=1146.99),
    dict(user_email=USER, tipo="DOLAR_LINKED", ticker_ars="MRCAO", ticker_usd="MRCAD",
         fecha_compra="2025-06-06", cantidad=50,    precio_compra_ars=28100, mep_compra=1194.00),
    dict(user_email=USER, tipo="DOLAR_LINKED", ticker_ars="MRCAO", ticker_usd="MRCAD",
         fecha_compra="2025-06-06", cantidad=1668,  precio_compra_ars=28500, mep_compra=1194.00),

    # ── BONOS SOBERANOS ───────────────────────────────────────────────────────
    dict(user_email=USER, tipo="BONO_SOBERANO", ticker_ars="AL30", ticker_usd="AL30D",
         fecha_compra="2025-11-13", cantidad=2867, precio_compra_ars=94170, mep_compra=1454.90),

    # ── CEDEARS ───────────────────────────────────────────────────────────────
    dict(user_email=USER, tipo="CEDEAR", ticker_ars="PG",   ticker_usd="PGD",
         ticker_adr="PG",   fecha_compra="2025-09-09", cantidad=61,
         precio_compra_ars=15240,  mep_compra=1427.00, precio_adr_compra=159.46, ratio_cedear="15", stop_loss=150.0),
    dict(user_email=USER, tipo="CEDEAR", ticker_ars="DOCU", ticker_usd="DOCUD",
         ticker_adr="DOCU", fecha_compra="2025-09-09", cantidad=119,
         precio_compra_ars=5215,   mep_compra=1427.00, precio_adr_compra=79.80,  ratio_cedear="22", stop_loss=66.0),
    dict(user_email=USER, tipo="CEDEAR", ticker_ars="DOCU", ticker_usd="DOCUD",
         ticker_adr="DOCU", fecha_compra="2025-09-18", cantidad=44,
         precio_compra_ars=5955,   mep_compra=1504.00, precio_adr_compra=85.01,  ratio_cedear="22", stop_loss=66.0),
    dict(user_email=USER, tipo="CEDEAR", ticker_ars="JD",   ticker_usd="JDD",
         ticker_adr="JD",   fecha_compra="2025-09-12", cantidad=44,
         precio_compra_ars=12300,  mep_compra=1450.00, precio_adr_compra=33.67,  ratio_cedear="4"),
    dict(user_email=USER, tipo="CEDEAR", ticker_ars="JD",   ticker_usd="JDD",
         ticker_adr="JD",   fecha_compra="2025-09-17", cantidad=52,
         precio_compra_ars=12970,  mep_compra=1482.35, precio_adr_compra=35.24,  ratio_cedear="4"),
    dict(user_email=USER, tipo="CEDEAR", ticker_ars="JD",   ticker_usd="JDD",
         ticker_adr="JD",   fecha_compra="2025-09-18", cantidad=20,
         precio_compra_ars=13290,  mep_compra=1504.00, precio_adr_compra=35.38,  ratio_cedear="4"),
    dict(user_email=USER, tipo="CEDEAR", ticker_ars="MELI", ticker_usd="MELID",
         ticker_adr="MELI", fecha_compra="2025-10-09", cantidad=129,
         precio_compra_ars=28060,  mep_compra=1505.00, precio_adr_compra=2275.00, ratio_cedear="120", stop_loss=2114.0),
    dict(user_email=USER, tipo="CEDEAR", ticker_ars="MELI", ticker_usd="MELID",
         ticker_adr="MELI", fecha_compra="2025-10-16", cantidad=63,
         precio_compra_ars=25640,  mep_compra=1479.00, precio_adr_compra=2043.06, ratio_cedear="120", stop_loss=2114.0),
    dict(user_email=USER, tipo="CEDEAR", ticker_ars="NKE",  ticker_usd="NKED",
         ticker_adr="NKE",  fecha_compra="2025-10-16", cantidad=194,
         precio_compra_ars=8335,   mep_compra=1479.00, precio_adr_compra=66.84,  ratio_cedear="12", stop_loss=52.0),
    dict(user_email=USER, tipo="CEDEAR", ticker_ars="SPY",  ticker_usd="SPYD",
         ticker_adr="SPY",  fecha_compra="2025-10-27", cantidad=118,
         precio_compra_ars=48700,  mep_compra=1417.00, precio_adr_compra=685.24, ratio_cedear="20"),
    dict(user_email=USER, tipo="CEDEAR", ticker_ars="NVDA", ticker_usd="NVDAD",
         ticker_adr="NVDA", fecha_compra="2025-11-18", cantidad=147,
         precio_compra_ars=11230,  mep_compra=1440.00, precio_adr_compra=181.36, ratio_cedear="24"),
    dict(user_email=USER, tipo="CEDEAR", ticker_ars="ORCL", ticker_usd="ORCLD",
         ticker_adr="ORCL", fecha_compra="2025-12-09", cantidad=3,
         precio_compra_ars=109825, mep_compra=1468.68, precio_adr_compra=221.53, ratio_cedear="3", stop_loss=66.0),
    dict(user_email=USER, tipo="CEDEAR", ticker_ars="ORCL", ticker_usd="ORCLD",
         ticker_adr="ORCL", fecha_compra="2025-12-11", cantidad=5,
         precio_compra_ars=97175,  mep_compra=1471.00, precio_adr_compra=198.85, ratio_cedear="3", stop_loss=66.0),
    dict(user_email=USER, tipo="CEDEAR", ticker_ars="OKLO", ticker_usd="OKLOD",
         ticker_adr="OKLO", fecha_compra="2025-12-09", cantidad=57,
         precio_compra_ars=5645,   mep_compra=1464.68, precio_adr_compra=103.93, stop_loss=66.0),
]

def insert(rows):
    url  = f"{SB_URL}/rest/v1/portafolio"
    body = json.dumps(rows).encode()
    ctx  = ssl.create_default_context()
    req  = urllib.request.Request(url, data=body, method="POST", headers={
        "apikey":        SB_KEY,
        "Authorization": f"Bearer {SB_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "return=minimal",
    })
    try:
        with urllib.request.urlopen(req, context=ctx) as r:
            return r.status
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8')
        print(f"\n[ERROR] HTTP {e.code}: {e.reason}")
        print(f"[DETALLE] {error_body}")
        raise

if __name__ == "__main__":
    print(f"Insertando {len(POSITIONS)} posiciones para {USER}...")
    # PostgREST exige que todos los objetos del array tengan las mismas claves
    ALL_KEYS = ['user_email','tipo','ticker_ars','ticker_usd','ticker_adr',
                'fecha_compra','cantidad','precio_compra_ars','mep_compra',
                'precio_adr_compra','ratio_cedear','stop_loss','notas','activo']
    normalized = [{**{k: p.get(k, None) for k in ALL_KEYS}, 'activo': True} for p in POSITIONS]
    status = insert(normalized)
    print(f"OK — HTTP {status}")
    print("Listo. Abri el dashboard y clickea Portafolio.")
