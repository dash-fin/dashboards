"""
process_iamc.py
Descarga el PDF de opciones de IAMC, lo procesa con Claude
y sube los datos a Supabase.
"""

import anthropic
import base64
import json
import os
import sys
import requests
from datetime import datetime, timedelta
from supabase import create_client

# ── Configuración ──────────────────────────────────────────
ANTHROPIC_KEY = os.environ["ANTHROPIC_KEY"]
SB_URL        = os.environ["SB_URL"]
SB_KEY        = os.environ["SB_KEY"]

# ── Construir URL del PDF ───────────────────────────────────
def build_url(fecha: datetime) -> str:
    """
    IAMC usa formato: AnexoOpcionesDDMMYYYY
    Ej: https://www.iamc.com.ar/Informe/AnexoOpciones23032026/
    """
    return f"https://www.iamc.com.ar/Informe/AnexoOpciones{fecha.strftime('%d%m%Y')}/"

def descargar_pdf(fecha: datetime) -> bytes | None:
    """
    Intenta descargar el PDF del día. Si no existe, prueba el día hábil anterior.
    Intenta hasta 5 días hacia atrás (cubre fines de semana y feriados).
    """
    for i in range(5):
        dia = fecha - timedelta(days=i)
        # Saltar fines de semana
        if dia.weekday() >= 5:
            continue
        url = build_url(dia)
        print(f"Intentando: {url}")
        try:
            r = requests.get(url, timeout=30)
            if r.status_code == 200 and b'%PDF' in r.content[:8]:
                print(f"✅ PDF encontrado para {dia.strftime('%d/%m/%Y')}")
                return r.content, dia
            # A veces IAMC devuelve HTML con un link al PDF real
            if r.status_code == 200 and b'<html' in r.content[:100].lower():
                # Intentar encontrar link al PDF en el HTML
                from html.parser import HTMLParser
                class PDFfinder(HTMLParser):
                    def __init__(self):
                        super().__init__()
                        self.pdf_url = None
                    def handle_starttag(self, tag, attrs):
                        if tag == 'a':
                            for attr, val in attrs:
                                if attr == 'href' and val and val.lower().endswith('.pdf'):
                                    self.pdf_url = val
                parser = PDFinder()
                parser.feed(r.text)
                if parser.pdf_url:
                    pdf_url = parser.pdf_url if parser.pdf_url.startswith('http') else f"https://www.iamc.com.ar{parser.pdf_url}"
                    print(f"  → PDF encontrado en: {pdf_url}")
                    r2 = requests.get(pdf_url, timeout=30)
                    if r2.status_code == 200:
                        return r2.content, dia
        except Exception as e:
            print(f"  Error: {e}")
    return None, None

# ── Prompt para Claude ──────────────────────────────────────
PROMPT = """Sos un extractor de datos de opciones financieras argentinas.
Este PDF contiene el informe diario de opciones de IAMC para GGAL (Grupo Financiero Galicia).

Extraé TODAS las filas de opciones de GGAL. Para cada opción extraé:
- symbol: el símbolo completo (ej: GFGC43747A)
- kind: "CALL" o "PUT" 
- strike: el precio de ejercicio como número (ej: 4374.7)
- expiration: fecha de vencimiento en formato YYYY-MM-DD (ej: 2026-04-17)
- open_interest: interés abierto como número entero
- volume: volumen del día como número entero
- last: último precio como número decimal
- bid: precio comprador como número decimal  
- ask: precio vendedor como número decimal
- settlement: siempre "24hs"
- underlying_asset: siempre "GGAL"

Si un campo no está disponible usá null.
Si no encontrás opciones de GGAL devolvé {"fecha": null, "opciones": []}.

Respondé SOLO con JSON válido, sin texto adicional, sin backticks, sin explicaciones.
Formato exacto:
{
  "fecha": "YYYY-MM-DD",
  "opciones": [
    {
      "symbol": "GFGC43747A",
      "kind": "CALL",
      "strike": 4374.7,
      "expiration": "2026-04-17",
      "open_interest": 1234,
      "volume": 56,
      "last": 123.5,
      "bid": 120.0,
      "ask": 125.0,
      "settlement": "24hs",
      "underlying_asset": "GGAL"
    }
  ]
}"""

# ── Procesar con Claude ─────────────────────────────────────
def procesar_con_claude(pdf_bytes: bytes) -> dict:
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
    pdf_b64 = base64.standard_b64encode(pdf_bytes).decode()
    
    print("Enviando PDF a Claude...")
    msg = client.messages.create(
        model="claude-opus-4-6",
        max_tokens=8000,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "document",
                    "source": {
                        "type": "base64",
                        "media_type": "application/pdf",
                        "data": pdf_b64
                    }
                },
                {
                    "type": "text",
                    "text": PROMPT
                }
            ]
        }]
    )
    
    raw = msg.content[0].text.strip()
    # Limpiar por si Claude igual manda backticks
    raw = raw.replace("```json", "").replace("```", "").strip()
    
    data = json.loads(raw)
    print(f"✅ Claude extrajo {len(data.get('opciones', []))} opciones")
    return data

# ── Subir a Supabase ────────────────────────────────────────
def subir_a_supabase(data: dict, fecha_pdf: datetime):
    if not data.get("opciones"):
        print("⚠️ Sin opciones para subir")
        return
    
    sb = create_client(SB_URL, SB_KEY)
    opciones = data["opciones"]
    
    # Agregar timestamp de cuando se procesó
    now_iso = datetime.utcnow().isoformat()
    for op in opciones:
        op["updated_at"] = now_iso
        op["fecha_informe"] = fecha_pdf.strftime("%Y-%m-%d")
    
    # Upsert por symbol + expiration (evita duplicados si corre dos veces)
    result = sb.table("opciones_rt").upsert(
        opciones,
        on_conflict="symbol,expiration"
    ).execute()
    
    print(f"✅ Subidas {len(opciones)} opciones a Supabase")
    
    # Log en tabla de historial si existe
    try:
        sb.table("iamc_upload_log").insert({
            "fecha_informe": fecha_pdf.strftime("%Y-%m-%d"),
            "opciones_count": len(opciones),
            "processed_at": now_iso,
            "status": "ok"
        }).execute()
    except:
        pass  # La tabla de log es opcional

# ── Main ────────────────────────────────────────────────────
def main():
    hoy = datetime.now()
    print(f"🚀 Iniciando proceso IAMC — {hoy.strftime('%d/%m/%Y %H:%M')}")
    
    # 1. Descargar PDF
    pdf_bytes, fecha_pdf = descargar_pdf(hoy)
    if not pdf_bytes:
        print("❌ No se pudo descargar el PDF de IAMC")
        sys.exit(1)
    
    # 2. Procesar con Claude
    data = procesar_con_claude(pdf_bytes)
    if not data.get("opciones"):
        print("❌ Claude no encontró opciones en el PDF")
        sys.exit(1)
    
    # 3. Subir a Supabase
    subir_a_supabase(data, fecha_pdf)
    
    print("✅ Proceso completado exitosamente")

if __name__ == "__main__":
    main()
