#!/usr/bin/env python3
"""
process_iamc.py
Descarga el PDF de opciones de IAMC, lo procesa con Claude 3.7
y sube los datos a la tabla 'opciones_iamc' en Supabase.
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

# ── Configuración y Seguridad ──────────────────────────────
# Desactivar advertencias de SSL por el bypass necesario para IAMC
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

ANTHROPIC_KEY = os.environ.get("ANTHROPIC_KEY")
SB_URL        = os.environ.get("SB_URL")
SB_KEY        = os.environ.get("SB_KEY")
TARGET_TABLE  = "opciones_iamc"

# Validar que las keys existan
if not all([ANTHROPIC_KEY, SB_URL, SB_KEY]):
    print("❌ Error: Faltan variables de entorno (ANTHROPIC_KEY, SB_URL o SB_KEY)")
    sys.exit(1)

# ── Funciones de Descarga ──────────────────────────────────
def build_url(fecha: datetime) -> str:
    """IAMC usa formato: AnexoOpcionesDDMMYYYY"""
    return f"https://www.iamc.com.ar/Informe/AnexoOpciones{fecha.strftime('%d%m%Y')}/"

def descargar_pdf(fecha: datetime) -> tuple[bytes, datetime] or tuple[None, None]:
    """
    Busca el PDF del día. Si no está, retrocede hasta 5 días (findes/feriados).
    Incluye bypass de SSL y manejo de redirecciones HTML de IAMC.
    """
    for i in range(6):
        dia = fecha - timedelta(days=i)
        if dia.weekday() >= 5: continue # Saltar Sábado y Domingo
        
        url = build_url(dia)
        print(f"Intentando: {url}")
        try:
            # verify=False para ignorar el error de certificado SSL del IAMC
            r = requests.get(url, timeout=30, verify=False)
            
            # Caso 1: Es el PDF directo
            if r.status_code == 200 and b'%PDF' in r.content[:8]:
                print(f"✅ PDF encontrado para {dia.strftime('%d/%m/%Y')}")
                return r.content, dia
            
            # Caso 2: Es un HTML que contiene el link al PDF (común en IAMC)
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
                    print(f"  → Redirección encontrada: {pdf_url}")
                    r2 = requests.get(pdf_url, timeout=30, verify=False)
                    if r2.status_code == 200:
                        return r2.content, dia
        except Exception as e:
            print(f"  ⚠️ Error en intento {dia.strftime('%d/%m')}: {e}")
            
    return None, None

# ── Lógica de Claude ───────────────────────────────────────
PROMPT = """Extraé TODAS las filas de opciones de GGAL del PDF adjunto. 
Buscá la tabla de 'Opciones' y filtrá solo las de Grupo Financiero Galicia (GGAL).
Respondé SOLO con un objeto JSON que tenga este formato:
{
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

def procesar_con_claude(pdf_bytes: bytes) -> dict:
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
    pdf_b64 = base64.standard_b64encode(pdf_bytes).decode()
    
    print("Enviando PDF a Claude (modelo 3.7-latest)...")
    msg = client.messages.create(
        model="claude-3-7-sonnet-latest", # Alias para la versión más reciente en 2026
        max_tokens=8192,
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
                { "type": "text", "text": PROMPT }
            ]
        }]
    )
    
    raw = msg.content[0].text.strip()
    # Limpiar posibles markdowns
    raw = raw.replace("```json", "").replace("```", "").strip()
    return json.loads(raw)

# ── Supabase ───────────────────────────────────────────────
def subir_a_supabase(data: dict, fecha_pdf: datetime):
    opciones = data.get("opciones", [])
    if not opciones:
        print("⚠️ No se extrajeron opciones para procesar.")
        return
    
    sb = create_client(SB_URL, SB_KEY)
    now_iso = datetime.utcnow().isoformat()
    
    # Preparar datos con metadatos de control
    for op in opciones:
        op["updated_at"] = now_iso
        op["fecha_informe"] = fecha_pdf.strftime("%Y-%m-%d")
    
    print(f"Subiendo {len(opciones)} filas a la tabla {TARGET_TABLE}...")
    
    # Upsert: Inserta nuevas o actualiza existentes basándose en symbol+expiration
    try:
        sb.table(TARGET_TABLE).upsert(
            opciones,
            on_conflict="symbol,expiration"
        ).execute()
        print("✅ Datos sincronizados correctamente.")
    except Exception as e:
        print(f"❌ Error al subir a Supabase: {e}")
        sys.exit(1)

# ── Ejecución Principal ─────────────────────────────────────
def main():
    inicio = datetime.now()
    print(f"🚀 Proceso IAMC Iniciado — {inicio.strftime('%Y-%m-%d %H:%M:%S')}")
    
    # 1. Obtener el archivo
    pdf_bytes, fecha_pdf = descargar_pdf(inicio)
    if not pdf_bytes:
        print("❌ Fallaron todos los intentos de descarga.")
        sys.exit(1)
    
    # 2. IA Extraction
    try:
        data = procesar_con_claude(pdf_bytes)
        print(f"✅ Claude procesó {len(data.get('opciones', []))} instrumentos.")
    except Exception as e:
        print(f"❌ Error en la API de Anthropic: {e}")
        sys.exit(1)
    
    # 3. DB Sync
    subir_a_supabase(data, fecha_pdf)
    
    print(f"🏁 Fin del proceso. Tiempo total: {datetime.now() - inicio}")

if __name__ == "__main__":
    main()
