#!/usr/bin/env python3
"""
process_iamc.py — Versión Ultra-Robusta (Abril 2026)
- Auto-detección de modelo Sonnet (evita Error 404 por EOL)
- Bypass SSL para IAMC y manejo de redirecciones
- Extracción de JSON con limpieza de decimales latinos y comas faltantes
- Carga relacional a la tabla 'opciones_iamc' con desglose de cobertura
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

# ── Seguridad y Configuración ──────────────────────────────────
# Silenciar advertencias de certificados para el sitio del IAMC
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

ANTHROPIC_KEY = os.environ.get("ANTHROPIC_KEY")
SB_URL        = os.environ.get("SB_URL")
SB_KEY        = os.environ.get("SB_KEY")
TARGET_TABLE  = "opciones_iamc"

def obtener_modelo_actual(client):
    """Detecta dinámicamente el modelo Sonnet más reciente en la cuenta."""
    try:
        models = client.models.list()
        disponibles = sorted(
            [m.id for m in models.data if "sonnet" in m.id.lower()],
            reverse=True
        )
        if disponibles:
            latests = [m for m in disponibles if "latest" in m]
            return latests[0] if latests else disponibles[0]
    except Exception as e:
        print(f"⚠️ Error listando modelos: {e}")
    return "claude-3-5-sonnet-latest" # Fallback de seguridad

# ── Descarga del PDF ───────────────────────────────────────────
def descargar_pdf(fecha: datetime):
    """Busca el PDF en IAMC manejando SSL y redirecciones HTML."""
    for i in range(6):
        dia = fecha - timedelta(days=i)
        if dia.weekday() >= 5: continue
        
        url = f"https://www.iamc.com.ar/Informe/AnexoOpciones{dia.strftime('%d%m%Y')}/"
        print(f"Intentando: {url}")
        try:
            r = requests.get(url, timeout=30, verify=False)
            
            if r.status_code == 200 and b'%PDF' in r.content[:8]:
                print(f"✅ PDF encontrado para el {dia.strftime('%d/%m/%Y')}")
                return r.content, dia
            
            if r.status_code == 200 and b'<html' in r.content[:100].lower():
                from html.parser import HTMLParser
                class PDFfinder(HTMLParser):
                    def __init__(self):
                        super().__init__(); self.pdf_url = None
                    def handle_starttag(self, tag, attrs):
                        if tag == 'a':
                            for attr, val in attrs:
                                if attr == 'href' and val.lower().endswith('.pdf'):
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
    Para cada fila, necesito estos datos exactos del informe:
    - symbol: código de base (ej: GFGC43747A)
    - kind: CALL o PUT
    - strike: precio de ejercicio (ej: 4374.7)
    - expiration: fecha de vencimiento (YYYY-MM-DD)
    - open_interest: columna 'TOTAL'
    - volume: columna 'VAR. C/ DIA ANT'
    - cubierto: columna 'CUBIERTO'
    - opuesto: columna 'OPUESTO'
    - cruce: columna 'CRUCE'
    - descubierto: columna 'DESCUBIERTO'

    REGLAS CRÍTICAS:
    1. PUNTO para decimales. SIN separadores de miles.
    2. Asegurá la COMA entre objetos del array.
    3. Respondé SOLO JSON minificado sin texto extra.
    """

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
    
    # --- EXTRACCIÓN Y REPARACIÓN DE JSON ---
    try:
        # 1. Buscar delimitadores por si la IA agregó texto
        start_idx = raw_content.find('{')
        end_idx = raw_content.rfind('}') + 1
        if start_idx == -1: raise ValueError("No se detectó JSON")
        json_str = raw_content[start_idx:end_idx]
        
        # 2. Reparar comas decimales latinas (ej: 123,45 -> 123.45)
        json_str = re.sub(r'(\d+),(\d+)', r'\1.\2', json_str)
        
        # 3. Reparar objetos pegados sin coma (ej: }{ -> }, {)
        json_str = re.sub(r'}\s*{', '}, {', json_str)
        
        return json.loads(json_str)
    except Exception as e:
        print(f"❌ Error al parsear respuesta: {e}")
        match = re.search(r'char (\d+)', str(e))
        if match:
            pos = int(match.group(1))
            print(f"Contexto del error: ...{json_str[max(0, pos-40):pos+40]}...")
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
    print(f"🚀 Iniciando Sincronización IAMC — {datetime.now().strftime('%H:%M:%S')}")
    
    if not all([ANTHROPIC_KEY, SB_URL, SB_KEY]):
        print("❌ Error: Faltan secretos en el entorno (SB_URL, SB_KEY o ANTHROPIC_KEY)")
        sys.exit(1)

    # 1. Obtener PDF
    pdf_bytes, fecha_pdf = descargar_pdf(datetime.now())
    if not pdf_bytes:
        print("❌ No se encontró PDF reciente.")
        sys.exit(1)
    
    # 2. IA Extract
    try:
        data = procesar_con_claude(pdf_bytes)
        print(f"✅ Se obtuvieron {len(data['opciones'])} opciones.")
    except Exception:
        sys.exit(1)
    
    # 3. DB Upload
    subir_a_supabase(data, fecha_pdf)

if __name__ == "__main__":
    main()
