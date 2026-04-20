#!/usr/bin/env python3
"""
process_iamc.py — Edición "Future-Proof" Abril 2026
1. Detecta dinámicamente el modelo Sonnet más reciente (evita errores 404).
2. Descarga PDF de IAMC con bypass de SSL.
3. Extrae opciones de GGAL y sube a Supabase (tabla opciones_iamc).
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

# ── Configuración ──────────────────────────────────────────────
# Silenciar advertencias de certificados inseguros
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

ANTHROPIC_KEY = os.environ.get("ANTHROPIC_KEY")
SB_URL        = os.environ.get("SB_URL")
SB_KEY        = os.environ.get("SB_KEY")
TARGET_TABLE  = "opciones_iamc"

def obtener_modelo_actual(client):
    """
    Lista los modelos disponibles en tu cuenta y selecciona el Sonnet más nuevo.
    Esto evita que el script falle cuando Anthropic retira versiones viejas.
    """
    try:
        models = client.models.list()
        # Filtramos los que contienen 'sonnet' y no son 'deprecated' en el nombre
        disponibles = sorted(
            [m.id for m in models.data if "sonnet" in m.id.lower()],
            reverse=True
        )
        if disponibles:
            # Priorizamos el alias '-latest' si existe, sino el primero de la lista
            latests = [m for m in disponibles if "latest" in m]
            seleccionado = latests[0] if latests else disponibles[0]
            print(f"🔍 Modelo detectado automáticamente: {seleccionado}")
            return seleccionado
    except Exception as e:
        print(f"⚠️ No se pudo listar modelos dinámicamente: {e}")
    
    # Fallback por si la API de listado falla
    return "claude-3-5-sonnet-latest"

# ── Descarga de Archivos ───────────────────────────────────────
def descargar_pdf(fecha: datetime):
    """Intenta descargar el PDF de los últimos 5 días hábiles."""
    for i in range(6):
        dia = fecha - timedelta(days=i)
        if dia.weekday() >= 5: continue
        
        url = f"https://www.iamc.com.ar/Informe/AnexoOpciones{dia.strftime('%d%m%Y')}/"
        print(f"Intentando: {url}")
        try:
            r = requests.get(url, timeout=30, verify=False)
            
            if r.status_code == 200 and b'%PDF' in r.content[:8]:
                return r.content, dia
            
            # Manejo de la redirección HTML típica de IAMC
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
                    print(f"  → Siguiendo link: {pdf_url}")
                    r2 = requests.get(pdf_url, timeout=30, verify=False)
                    if r2.status_code == 200:
                        return r2.content, dia
        except Exception as e:
            print(f"  ❌ Error en intento {dia.strftime('%d/%m')}: {e}")
            
    return None, None

# ── Extracción con Claude ──────────────────────────────────────
def procesar_con_claude(pdf_bytes: bytes) -> dict:
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
    
    # Selección dinámica de modelo
    modelo_a_usar = obtener_modelo_actual(client)
    
    pdf_b64 = base64.standard_b64encode(pdf_bytes).decode()
    
    print(f"Enviando PDF a Claude ({modelo_a_usar})...")
    
    prompt = """Extraé todas las filas de opciones de GGAL del PDF.
    Respondé exclusivamente en JSON con este formato:
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
    
    raw = msg.content[0].text.strip()
    raw = re.sub(r'```json\n?|```', '', raw) # Limpieza de markdown
    return json.loads(raw)

# ── Carga a Base de Datos ──────────────────────────────────────
def subir_a_supabase(data: dict, fecha_pdf: datetime):
    opciones = data.get("opciones", [])
    if not opciones:
        print("⚠️ No hay opciones para subir.")
        return
    
    sb = create_client(SB_URL, SB_KEY)
    now_iso = datetime.utcnow().isoformat()
    
    for op in opciones:
        op["updated_at"] = now_iso
        op["fecha_informe"] = fecha_pdf.strftime("%Y-%m-%d")
    
    print(f"Subiendo {len(opciones)} filas a {TARGET_TABLE}...")
    
    # Usamos upsert con la restricción de unicidad definida en SQL
    try:
        sb.table(TARGET_TABLE).upsert(
            opciones,
            on_conflict="symbol,expiration"
        ).execute()
        print("✅ Sincronización exitosa.")
    except Exception as e:
        print(f"❌ Error en Supabase: {e}")
        sys.exit(1)

# ── Main ───────────────────────────────────────────────────────
def main():
    print(f"🚀 Iniciando Proceso — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    
    if not all([ANTHROPIC_KEY, SB_URL, SB_KEY]):
        print("❌ Faltan variables de entorno.")
        sys.exit(1)

    # 1. Obtener PDF
    pdf_bytes, fecha_pdf = descargar_pdf(datetime.now())
    if not pdf_bytes:
        print("❌ No se encontró ningún PDF reciente.")
        sys.exit(1)
    
    # 2. IA Parsing
    try:
        data = procesar_con_claude(pdf_bytes)
        print(f"✅ Se extrajeron {len(data['opciones'])} opciones.")
    except Exception as e:
        print(f"❌ Error en Claude: {e}")
        sys.exit(1)
    
    # 3. DB Upload
    subir_a_supabase(data, fecha_pdf)

if __name__ == "__main__":
    main()
