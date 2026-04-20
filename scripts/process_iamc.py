#!/usr/bin/env python3
"""
process_iamc.py — Versión Final "Cristian Edition" (Abril 2026)
- Auto-detección de modelo Sonnet 4.x
- Bypass SSL para IAMC
- Reparador de JSON avanzado: maneja objetos sueltos o arrays sin envolver.
- Upsert relacional en Supabase.
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
                        if tag == 'a':
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

# ── IA Parsing con Extracción Profunda ─────────────────────────
def procesar_con_claude(pdf_bytes: bytes) -> dict:
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
    modelo = obtener_modelo_actual(client)
    pdf_b64 = base64.standard_b64encode(pdf_bytes).decode()
    
    print(f"Enviando PDF a Claude ({modelo})...")
    
    prompt = """Extraé TODAS las filas de GGAL. 
    JSON puro, decimales con punto, sin miles. 
    Formato: {"opciones": [{"symbol": "...", "kind": "...", "strike": 0.0, "expiration": "YYYY-MM-DD", "open_interest": 0, "volume": 0, "cubierto": 0, "opuesto": 0, "cruce": 0, "descubierto": 0}]}"""

    msg = client.messages.create(
        model=modelo,
        max_tokens=8192,
        messages=[{"role": "user", "content": [
            {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_b64}},
            {"type": "text", "text": prompt}
        ]}]
    )
    
    raw = msg.content[0].text.strip()
    
    # 1. Limpieza básica
    clean = re.sub(r'```json\n?|```', '', raw).strip()
    
    # 2. Intento de parseo directo
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        print("⚠️ Parseo directo falló. Iniciando reconstrucción de emergencia...")
        
        # 3. EMERGENCIA: Si Claude mandó {...},{...} sin el wrapper
        # Buscamos todos los bloques que parecen objetos JSON
        objetos = re.findall(r'\{[^{}]+\}', clean)
        
        if objetos:
            print(f"🔧 Se encontraron {len(objetos)} objetos sueltos. Reconstruyendo array...")
            lista_reparada = []
            for obj in objetos:
                try:
                    # Limpiamos posibles comas decimales latinas en el objeto
                    obj_clean = re.sub(r'(\d+),(\d+)', r'\1.\2', obj)
                    lista_reparada.append(json.loads(obj_clean))
                except:
                    continue
            return {"opciones": lista_reparada}
        
        raise ValueError("No se pudo reconstruir un JSON válido de la respuesta de Claude.")

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
    
    print(f"Subiendo {len(opciones)} registros...")
    try:
        sb.table(TARGET_TABLE).upsert(opciones, on_conflict="symbol,expiration").execute()
        print("✅ Sincronización exitosa.")
    except Exception as e:
        print(f"❌ Error Supabase: {e}")
        sys.exit(1)

def main():
    print(f"🚀 Sincro IAMC — {datetime.now().strftime('%H:%M:%S')}")
    if not all([ANTHROPIC_KEY, SB_URL, SB_KEY]):
        print("❌ Faltan secretos."); sys.exit(1)

    pdf, fecha = descargar_pdf(datetime.now())
    if not pdf:
        print("❌ PDF no encontrado."); sys.exit(1)
    
    try:
        data = procesar_con_claude(pdf)
        subir_a_supabase(data, fecha)
    except Exception as e:
        print(f"❌ Fallo total: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
