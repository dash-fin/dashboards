# ... (mantené los imports y el inicio igual hasta el PROMPT)

PROMPT = """Extraé TODAS las filas de opciones de GGAL del PDF. 
Para cada fila, necesito estos datos exactos del informe:
- symbol: el código de la base (ej: GFGC43747A)
- kind: CALL o PUT
- strike: el precio de ejercicio (ej: 4374.7)
- expiration: fecha de vencimiento (YYYY-MM-DD)
- open_interest: es la columna 'TOTAL' del informe
- volume: es la columna 'VAR. C/ DIA ANT'
- cubierto: columna 'CUBIERTO'
- opuesto: columna 'OPUESTO'
- cruce: columna 'CRUCE'
- descubierto: columna 'DESCUBIERTO'

REGLAS:
1. Decimales con PUNTO. Sin separadores de miles.
2. Respondé SOLO JSON puro minificado:
{"opciones": [{"symbol": "...", "kind": "...", "strike": 0.0, "expiration": "...", "open_interest": 0, "volume": 0, "cubierto": 0, "opuesto": 0, "cruce": 0, "descubierto": 0}]}
"""

# ... (en la función subir_a_supabase, asegurate de incluir los nuevos campos)

def subir_a_supabase(data: dict, fecha_pdf: datetime):
    opciones = data.get("opciones", [])
    if not opciones: return
    
    sb = create_client(SB_URL, SB_KEY)
    now_iso = datetime.utcnow().isoformat()
    
    for op in opciones:
        op["updated_at"] = now_iso
        op["fecha_informe"] = fecha_pdf.strftime("%Y-%m-%d")
        # Estos son los campos que Claude va a extraer ahora:
        # op["cubierto"], op["opuesto"], etc.
    
    sb.table(TARGET_TABLE).upsert(opciones, on_conflict="symbol,expiration").execute()
    print(f"✅ {len(opciones)} opciones con desglose cargadas.")
