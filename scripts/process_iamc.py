#!/usr/bin/env python3
"""
process_iamc.py — Edición "Tanque" (Abril 2026)
- Auto-detección de Sonnet 4.x
- Bypass SSL
- Reparador de sintaxis JSON (comas faltantes y decimales latinos)
- Minificación de prompt para ahorrar tokens
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
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

ANTHROPIC_KEY = os.environ.get("ANTHROPIC_KEY")
SB_URL        = os.environ.get("SB_URL")
SB_KEY        = os.environ.get("SB_KEY")
TARGET_TABLE  = "opciones_iamc"

def obtener_modelo_actual(client):
    try:
        models = client.models.list()
        disponibles = sorted([m.id for m in models.data if "sonnet" in m.id.lower()], reverse=True)
        if disponibles:
            latests = [m for m in disponibles if "latest" in m]
            return latests[0] if latests else disponibles[0]
    except: pass
    return "claude-3-5-sonnet-latest"

# ── Descarga ───────────────────────────────────────────────────
def descargar_pdf(fecha: datetime):
    for i in range(6):
        dia = fecha - timedelta(days=i)
        if dia.weekday() >= 5: continue
        url = f"https://www.iamc.com.ar/Informe/AnexoOpciones{dia.strftime('%d%m%Y')}/"
        try:
            r = requests.get(url, timeout=30, verify=False)
            if r.status_code == 200 and b'%PDF' in r.content[:8]:
                return r.content, dia
            if r.status_code == 200 and b'<html' in r.content[:100].lower():
                from html.parser import HTMLParser
                class PDFfinder(HTMLParser):
                    def __init__(self):
                        super().__init__(); self.pdf_url = None
                    def handle_starttag(self, tag, attrs):
                        if tag == 'a' and not self.pdf_url:
                            for attr, val in attrs:
                                if attr == 'href' and val.lower().endswith('.pdf'): self.pdf_url = val
                parser = PDFfinder()
                parser.feed(r.text)
                if parser.pdf_url:
                    pdf_url = parser.pdf_url if parser.pdf_url.startswith('http') else f"https://www.iamc.com.ar{parser.pdf_url}"
                    r2 = requests.get(pdf_url, timeout=30, verify=False)
                    if r2.status_code == 200: return r2.content, dia
        except: pass
    return None, None

# ── IA Parsing con Reparación Automática ───────────────────────
def procesar_con_claude(pdf_bytes: bytes) -> dict:
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
    modelo = obtener_modelo_actual(client)
    pdf_b64 = base64.standard_b64encode(pdf_bytes).decode()
    
    print(f"Enviando PDF a Claude ({modelo})...")
    
    prompt = """Extraé TODAS las opciones de GGAL del PDF. 
    REGLAS DE FORMATO (ESTRICTO):
    1. PUNTO para decimales (ej: 1500.50). NUNCA comas.
    2. SIN separadores de miles.
    3. Asegurá la COMA entre objetos del array.
    4. Respondé SOLO el JSON minificado (sin espacios ni saltos de línea).
    
    Esquema: {"opciones": [{"symbol": "...", "kind": "CALL/PUT", "strike": 0.0, "expiration": "YYYY-MM-DD", "open_interest": 0, "volume": 0, "last": 0.0, "bid": 0.0, "ask": 0.0, "settlement": "24hs", "underlying_asset": "GGAL"}]}"""

    msg = client.messages.create(
        model=modelo,
        max_tokens=8192,
        messages=[{"role": "user", "content": [
            {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_b64}},
            {"type": "text", "text": prompt}
        ]}]
    )
    
    raw = msg.content[0].text.strip()
    
    try:
        # 1. Extraer solo el bloque de llaves
        start = raw.find('{')
        end = raw.rfind('}') + 1
        if start == -1: raise ValueError("No se detectó JSON")
        json_str = raw[start:end]
        
        # 2. PARCHE QUIRÚRGICO A: Fix comas decimales latinas que se hayan filtrado
        json_str = re.sub(r'(\d+),(\d+)', r'\1.\2', json_str)
        
        # 3. PARCHE QUIRÚRGICO B: Fix objetos pegados sin coma -> } {  por  }, {
        # Esto soluciona el error "Expecting ',' delimiter"
        json_str = re.sub(r'}\s*{', '}, {', json_str)

        return json.loads(json_str)
    except Exception as e:
        print(f"❌ Error crítico de parsing: {e}")
        # Mostrar contexto del error para ver qué carácter molestó
        match = re.search(r'char (\d+)', str(e))
        if match:
            pos = int(match.group(1))
            print(f"Contexto: ...{json_str[max(0, pos-50):pos+50]}...")
        raise

# ── Supabase ───────────────────────────────────────────────────
def subir_a_supabase(data: dict, fecha_pdf: datetime):
    opciones = data.get("opciones", [])
    if not opciones: 
        print("⚠️ No hay datos."); return
    
    sb = create_client(SB_URL, SB_KEY)
    now = datetime.utcnow().isoformat()
    for op in opciones:
        op["updated_at"] = now
        op["fecha_informe"] = fecha_pdf.strftime("%Y-%m-%d")
    
    print(f"Subiendo {len(opciones)} registros a '{TARGET_TABLE}'...")
    try:
        sb.table(TARGET_TABLE).upsert(opciones, on_conflict="symbol,expiration").execute()
        print("✅ ¡Sincronización Exitosa!")
    except Exception as e:
        print(f"❌ Error Supabase: {e}")
        sys.exit(1)

def main():
    print(f"🚀 Inicio Sincro — {datetime.now().strftime('%H:%M:%S')}")
    pdf, fecha = descargar_pdf(datetime.now())
    if not pdf: 
        print("❌ PDF no disponible."); sys.exit(1)
    
    try:
        data = procesar_con_claude(pdf)
        subir_a_supabase(data, fecha)
    except:
        sys.exit(1)

if __name__ == "__main__":
    main()
