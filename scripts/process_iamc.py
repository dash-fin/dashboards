#!/usr/bin/env python3
"""
process_iamc.py — Versión Final Robusta (Abril 2026)
- Auto-detección de modelo Sonnet (evita Error 404)
- Bypass SSL para IAMC
- Extracción de JSON blindada (ignora texto extra de la IA)
- Upsert en tabla 'opciones_iamc'
"""

import anthropic
import base64
import json
import os
import sys
import requests
import urllib3
import re
from datetime import datetime, timedelta
from supabase import create_client

# ── Configuración de Seguridad ─────────────────────────────────
# Silenciar advertencias de certificados (necesario para la web del IAMC)
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

ANTHROPIC_KEY = os.environ.get("ANTHROPIC_KEY")
SB_URL        = os.environ.get("SB_URL")
SB_KEY        = os.environ.get("SB_KEY")
TARGET_TABLE  = "opciones_iamc"

def obtener_modelo_actual(client):
    """Detecta dinámicamente el modelo Sonnet más reciente en la cuenta."""
    try:
        models = client.models.list()
        # Filtramos modelos que contengan 'sonnet' y los ordenamos (el más nuevo primero)
        disponibles = sorted(
            [m.id for m in models.data if "sonnet" in m.id.lower()],
            reverse=True
        )
        if disponibles:
            # Preferimos el alias 'latest' si existe, sino el más nuevo de la lista
            latests = [m for m in disponibles if "latest" in m]
            return latests[0] if latests else disponibles[0]
    except Exception as e:
        print(f"⚠️ Error listando modelos: {e}")
    return "claude-3-5-sonnet-latest" # Fallback de seguridad

# ── Descarga del PDF ───────────────────────────────────────────
def descargar_pdf(fecha: datetime):
    """Busca el PDF en IAMC manejando SSL y redirecciones."""
    for i in range(6):
        dia = fecha - timedelta(days=i)
        if dia.weekday() >= 5: continue
        
        url = f"https://www.iamc.com.ar/Informe/AnexoOpciones{dia.strftime('%d%m%Y')}/"
        print(f"Intentando: {url}")
        try:
            # verify=False para bypass de SSL
            r = requests.get(url, timeout=30, verify=False)
            
            if r.status_code == 200 and b'%PDF' in r.content[:8]:
                print(f"✅ PDF encontrado directamente para el {dia.strftime('%d/%m/%Y')}")
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
                    print(f"  → Siguiendo redirección: {pdf_url}")
                    r2 = requests.get(pdf_url, timeout=30, verify=False)
                    if r2.status_code == 200:
                        return r2.content, dia
        except Exception as e:
            print(f"  ❌ Fallo en intento {dia.strftime('%d/%m')}: {e}")
            
    return None, None

# ── Procesamiento con Claude ───────────────────────────────────
def procesar_con_claude(pdf_bytes: bytes) -> dict:
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
    modelo_a_usar = obtener_modelo_actual(client)
    
    pdf_b64 = base64.standard_b64encode(pdf_bytes).decode()
    print(f"Enviando PDF a Claude ({modelo_a_usar})...")
    
    prompt = """Extraé todas las filas de opciones de GGAL del PDF. 
    Ignorá otros activos. Generá un JSON puro con este formato:
    {"opciones": [{"symbol": "...", "kind": "...", "strike": 0.0, "expiration": "YYYY-MM-DD", "open_interest": 0, "volume": 0, "last": 0.0, "bid": 0.0, "ask": 0.0, "settlement": "24hs", "underlying_asset": "GGAL"}]}"""

    msg = client.messages.create(
        model=modelo_a_usar,
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
                { "type": "text", "text": prompt }
            ]
        }]
    )
    
    raw_content = msg.content[0].text.strip()
    
    # --- EXTRACCIÓN DE JSON SEGURA ---
    try:
        # Buscamos el inicio y fin real del objeto JSON por si la IA agregó texto extra
        start_idx = raw_content.find('{')
        end_idx = raw_content.rfind('}') + 1
        
        if start_idx == -1 or end_idx == 0:
            print(f"DEBUG - Respuesta cruda de Claude:\n{raw_content}")
            raise ValueError("No se encontró un bloque JSON válido en la respuesta.")
            
        json_str = raw_content[start_idx:end_idx]
        return json.loads(json_str)
    except Exception as e:
        print(f"❌ Error al parsear respuesta de Claude: {e}")
        print(f"Contenido recibido (primeros 300 caracteres): {raw_content[:300]}")
        raise

# ── Carga a Supabase ───────────────────────────────────────────
def subir_a_supabase(data: dict, fecha_pdf: datetime):
    opciones = data.get("opciones", [])
    if not opciones:
        print("⚠️ No hay datos para subir.")
        return
    
    sb = create_client(SB_URL, SB_KEY)
    now_iso = datetime.utcnow().isoformat()
    
    for op in opciones:
        op["updated_at"] = now_iso
        op["fecha_informe"] = fecha_pdf.strftime("%Y-%m-%d")
    
    print(f"Subiendo {len(opciones)} registros a '{TARGET_TABLE}'...")
    
    try:
        # Upsert basado en la restricción UNIQUE (symbol, expiration)
        sb.table(TARGET_TABLE).upsert(
            opciones,
            on_conflict="symbol,expiration"
        ).execute()
        print("✅ Base de datos actualizada correctamente.")
    except Exception as e:
        print(f"❌ Error en Supabase Upsert: {e}")
        sys.exit(1)

# ── Main ───────────────────────────────────────────────────────
def main():
    print(f"🚀 Iniciando Sincronización IAMC — {datetime.now().strftime('%H:%M:%S')}")
    
    if not all([ANTHROPIC_KEY, SB_URL, SB_KEY]):
        print("❌ Error: Faltan secretos en las variables de entorno.")
        sys.exit(1)

    # 1. Obtener Archivo
    pdf_bytes, fecha_pdf = descargar_pdf(datetime.now())
    if not pdf_bytes:
        print("❌ No se pudo localizar el PDF de los últimos días hábiles.")
        sys.exit(1)
    
    # 2. IA Extract
    try:
        data = procesar_con_claude(pdf_bytes)
        print(f"✅ Se obtuvieron {len(data['opciones'])} opciones.")
    except Exception:
        sys.exit(1) # Error detallado ya impreso en la función
    
    # 3. DB Upload
    subir_a_supabase(data, fecha_pdf)

if __name__ == "__main__":
    main()
