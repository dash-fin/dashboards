"""
process_iamc.py
Descarga el PDF de opciones de IAMC, lo procesa con Claude
y sube los datos a la tabla 'opciones_iamc'.
"""

import anthropic
import base64
import json
import os
import sys
import requests
import urllib3
from datetime import datetime, timedelta
from supabase import create_client

# Desactivar advertencias de SSL por el bypass
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ── Configuración ──────────────────────────────────────────
ANTHROPIC_KEY = os.environ["ANTHROPIC_KEY"]
SB_URL        = os.environ["SB_URL"]
SB_KEY        = os.environ["SB_KEY"]
TARGET_TABLE  = "opciones_iamc" # <--- Cambiado a la nueva tabla

# ── Construir URL del PDF ───────────────────────────────────
def build_url(fecha: datetime) -> str:
    return f"https://www.iamc.com.ar/Informe/AnexoOpciones{fecha.strftime('%d%m%Y')}/"

def descargar_pdf(fecha: datetime) -> bytes | None:
    for i in range(5):
        dia = fecha - timedelta(days=i)
        if dia.weekday() >= 5: continue
        url = build_url(dia)
        print(f"Intentando: {url}")
        try:
            r = requests.get(url, timeout=30, verify=False)
            if r.status_code == 200 and b'%PDF' in r.content[:8]:
                print(f"✅ PDF encontrado para {dia.strftime('%d/%m/%Y')}")
                return r.content, dia
            
            if r.status_code == 200 and b'<html' in r.content[:100].lower():
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
                
                parser = PDFfinder()
                parser.feed(r.text)
                if parser.pdf_url:
                    pdf_url = parser.pdf_url if parser.pdf_url.startswith('http') else f"https://www.iamc.com.ar{parser.pdf_url}"
                    print(f"  → PDF encontrado en: {pdf_url}")
                    r2 = requests.get(pdf_url, timeout=30, verify=False)
                    if r2.status_code == 200:
                        return r2.content, dia
        except Exception as e:
            print(f"  Error: {e}")
    return None, None

# ── Prompt para Claude ──────────────────────────────────────
PROMPT = """Extraé TODAS las filas de opciones de GGAL del PDF adjunto. 
Respondé SOLO JSON con este formato:
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
        model="claude-3-5-sonnet-20240620", # Usando un modelo balanceado
        max_tokens=8000,
        messages=[{
            "role": "user",
            "content": [
                { "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": pdf_b64 } },
                { "type": "text", "text": PROMPT }
            ]
        }]
    )
    
    raw = msg.content[0].text.strip()
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
    
    now_iso = datetime.utcnow().isoformat()
    for op in opciones:
        op["updated_at"] = now_iso
        op["fecha_informe"] = fecha_pdf.strftime("%Y-%m-%d")
    
    # Upsert usando la nueva tabla y el constraint de símbolo+vencimiento
    result = sb.table(TARGET_TABLE).upsert(
        opciones,
        on_conflict="symbol,expiration"
    ).execute()
    
    print(f"✅ Subidas {len(opciones)} opciones a la tabla {TARGET_TABLE}")
    
    try:
        sb.table("iamc_upload_log").insert({
            "fecha_informe": fecha_pdf.strftime("%Y-%m-%d"),
            "opciones_count": len(opciones),
            "processed_at": now_iso,
            "status": "ok"
        }).execute()
    except Exception as e:
        print(f"⚠️ No se pudo guardar el log: {e}")

# ── Main ────────────────────────────────────────────────────
def main():
    hoy = datetime.now()
    print(f"🚀 Iniciando proceso IAMC — {hoy.strftime('%d/%m/%Y %H:%M')}")
    
    pdf_bytes, fecha_pdf = descargar_pdf(hoy)
    if not pdf_bytes:
        print("❌ No se pudo descargar el PDF")
        sys.exit(1)
    
    data = procesar_con_claude(pdf_bytes)
    if not data.get("opciones"):
        print("❌ Sin datos extraídos")
        sys.exit(1)
    
    subir_a_supabase(data, fecha_pdf)
    print("✅ Proceso completado exitosamente")

if __name__ == "__main__":
    main()
