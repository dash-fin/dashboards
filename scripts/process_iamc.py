#!/usr/bin/env python3
"""
process_iamc.py — con soporte de historico diario
Modos:
  python process_iamc.py              → proceso del dia (upsert opciones_iamc + snapshot historico)
  python process_iamc.py --backfill YYYY-MM-DD:YYYY-MM-DD → solo historico, sin tocar opciones_iamc
  python process_iamc.py --fecha YYYY-MM-DD               → procesa una fecha puntual
"""

import anthropic
import base64
import json
import os
import sys
import requests
import urllib3
import re
from datetime import datetime, timedelta, date
from supabase import create_client

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

ANTHROPIC_KEY = os.environ.get("ANTHROPIC_KEY")
SB_URL        = os.environ.get("SB_URL")
SB_KEY        = os.environ.get("SB_KEY")
TARGET_TABLE  = "opciones_iamc"
HIST_TABLE    = "opciones_historico"

# ── Helpers ────────────────────────────────────────────────────
def obtener_modelo_actual(client):
    try:
        models = client.models.list()
        disponibles = sorted([m.id for m in models.data if "sonnet" in m.id.lower()], reverse=True)
        if disponibles:
            latests = [m for m in disponibles if "latest" in m]
            return latests[0] if latests else disponibles[0]
    except: pass
    return "claude-3-5-sonnet-latest"

def tercerViernes(year, month):
    """Devuelve la fecha del 3er viernes de un mes dado."""
    d = date(year, month, 1)
    viernes = 0
    while True:
        if d.weekday() == 4:
            viernes += 1
            if viernes == 3:
                return d
        d += timedelta(days=1)

def vencimientoActivo(fecha_ref: date) -> date:
    """Devuelve el vencimiento vigente (3er viernes de mes par, el mas proximo a fecha_ref)."""
    meses_par = [2, 4, 6, 8, 10, 12]
    candidatos = []
    for y in [fecha_ref.year, fecha_ref.year + 1]:
        for m in meses_par:
            v = tercerViernes(y, m)
            if v >= fecha_ref:
                candidatos.append(v)
    candidatos.sort()
    return candidatos[0]

# ── Descarga PDF ───────────────────────────────────────────────
def descargar_pdf(fecha: datetime):
    """Descarga el PDF IAMC para una fecha dada (o retrocede hasta 6 dias habiles)."""
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

def descargar_pdf_exacto(fecha_obj: date):
    """Descarga el PDF para una fecha exacta sin retrocecer (para backfill)."""
    if fecha_obj.weekday() >= 5:
        return None, None
    url = f"https://www.iamc.com.ar/Informe/AnexoOpciones{fecha_obj.strftime('%d%m%Y')}/"
    try:
        r = requests.get(url, timeout=30, verify=False)
        if r.status_code == 200 and b'%PDF' in r.content[:8]:
            return r.content, fecha_obj
        if r.status_code == 200 and b'<html' in r.content[:100].lower():
            from html.parser import HTMLParser
            class PDFfinder(HTMLParser):
                def __init__(self): super().__init__(); self.pdf_url = None
                def handle_starttag(self, tag, attrs):
                    if tag == 'a':
                        for attr, val in attrs:
                            if attr == 'href' and val.lower().endswith('.pdf'): self.pdf_url = val
            parser = PDFfinder(); parser.feed(r.text)
            if parser.pdf_url:
                pdf_url = parser.pdf_url if parser.pdf_url.startswith('http') else f"https://www.iamc.com.ar{parser.pdf_url}"
                r2 = requests.get(pdf_url, timeout=30, verify=False)
                if r2.status_code == 200: return r2.content, fecha_obj
    except: pass
    return None, None

# ── Parsing con Claude ─────────────────────────────────────────
def procesar_con_claude(pdf_bytes: bytes) -> dict:
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
    modelo = obtener_modelo_actual(client)
    pdf_b64 = base64.standard_b64encode(pdf_bytes).decode()
    print(f"  → Claude ({modelo})...")

    prompt = """Sos un extractor de datos financieros. Del PDF adjunto extraé TODAS las filas de opciones de GGAL (Grupo Financiero Galicia).

REGLAS CRÍTICAS — leé con atención:

1. "symbol": el código exacto de la opción tal como aparece en el PDF (ej: GFGC71487J).

2. "kind": "call" o "put" en minúsculas.

3. "strike": el precio de ejercicio como número ENTERO en pesos, copiado tal cual del PDF.
   - Si el PDF dice 71487 → strike: 71487
   - Si el PDF dice 43.487 con punto como separador de miles → strike: 43487
   - NUNCA dividas el número ni uses punto decimal. El strike de GGAL es siempre un entero de 4-6 dígitos.

4. "expiration": la fecha de vencimiento EXACTA leída del encabezado de columna del PDF, en formato YYYY-MM-DD.
   - NO la inferás del símbolo ni del código de letra.
   - Las opciones de GGAL vencen el tercer viernes del mes (ej: 2026-06-19, 2026-07-17).
   - Si el PDF no muestra la fecha completa, inferí el tercer viernes del mes indicado.

5. Campos numéricos (open_interest, volume, cubierto, opuesto, cruce, descubierto): enteros. Guión o vacío = 0.

Devolvé SOLO JSON válido sin texto extra ni markdown:
{"opciones": [{"symbol": "GFGC71487J", "kind": "call", "strike": 71487, "expiration": "2026-06-19", "open_interest": 0, "volume": 0, "cubierto": 0, "opuesto": 0, "cruce": 0, "descubierto": 0}]}"""

    msg = client.messages.create(
        model=modelo, max_tokens=8192,
        messages=[{"role": "user", "content": [
            {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_b64}},
            {"type": "text", "text": prompt}
        ]}]
    )

    raw = msg.content[0].text.strip()
    clean = re.sub(r'```json\n?|```', '', raw).strip()

    try:
        parsed = json.loads(clean)
        # Normalizar: siempre devolver {"opciones": [lista]}
        lista = _extraer_lista(parsed) if not isinstance(parsed, list) else parsed
        return {"opciones": lista}
    except json.JSONDecodeError:
        print(f"  ⚠️  Parseo directo falló — respuesta Claude (500 chars): {raw[:500]}")
        # Intentar extraer el bloque JSON de array directamente
        m = re.search(r'\[\s*\{.*\}\s*\]', clean, re.DOTALL)
        if m:
            try:
                lista = json.loads(m.group(0))
                print(f"  → Extraído array directamente: {len(lista)} filas")
                return {"opciones": lista}
            except: pass
        # Fallback: regex para objetos planos
        objetos = re.findall(r'\{[^{}]+\}', clean)
        if objetos:
            lista = []
            for obj in objetos:
                try:
                    parsed_obj = json.loads(obj)
                    if parsed_obj.get("symbol"):  # solo objetos con symbol válido
                        lista.append(parsed_obj)
                except: continue
            if lista:
                print(f"  → Fallback regex: {len(lista)} objetos con symbol")
                return {"opciones": lista}
        print(f"  ❌ No se pudo extraer datos del PDF.")
        return {"opciones": []}

IAMC_COLS = {"symbol","kind","strike","expiration","open_interest","volume","cubierto","opuesto","cruce","descubierto","updated_at","fecha_informe"}

def _extraer_lista(data):
    """Extrae la lista de opciones tolerando nesting variable del JSON de Claude."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        val = data.get("opciones", data.get("options", []))
        if isinstance(val, list):
            return val
        if isinstance(val, dict):
            return _extraer_lista(val)
    return []

# ── Upsert diario a opciones_iamc (sin cambios) ───────────────
def subir_a_supabase(data: dict, fecha_pdf: datetime):
    opciones = _extraer_lista(data)
    if not opciones: print("  ⚠️  Sin datos."); return
    sb = create_client(SB_URL, SB_KEY)
    now_iso = datetime.utcnow().isoformat()
    rows = []
    for op in opciones:
        if not isinstance(op, dict): continue
        if not op.get("symbol"): continue  # descartar filas sin symbol
        op["updated_at"] = now_iso
        op["fecha_informe"] = fecha_pdf.strftime("%Y-%m-%d")
        rows.append({k: v for k, v in op.items() if k in IAMC_COLS})
    if not rows: print("  ⚠️  Sin filas válidas tras limpieza."); return
    print(f"  → Upsert {len(rows)} filas en {TARGET_TABLE}...")
    try:
        sb.table(TARGET_TABLE).upsert(rows, on_conflict="symbol,expiration").execute()
        print("  ✅ opciones_iamc OK.")
    except Exception as e:
        print(f"  ❌ Error: {e}"); raise

# ── Snapshot historico ─────────────────────────────────────────
def snapshot_historico(data: dict, fecha_informe: date):
    """
    Guarda en opciones_historico todas las filas del PDF cuya expiration
    sea futura respecto a fecha_informe (descarta series ya vencidas).
    Ignora duplicados (re-run seguro).
    """
    opciones = _extraer_lista(data)
    if not opciones: return

    # Vencimiento activo = el 3er viernes de mes par más próximo
    vto_activo = vencimientoActivo(fecha_informe)
    vto_str    = vto_activo.strftime("%Y-%m-%d")

    filas = []
    for op in opciones:
        exp_str = op.get("expiration", "")
        if exp_str != vto_str:
            continue
        filas.append({
            "fecha_informe":  fecha_informe.strftime("%Y-%m-%d"),
            "expiration":     exp_str,
            "strike":         op.get("strike", 0),
            "kind":           op.get("kind", ""),
            "cubierto":       int(op.get("cubierto", 0) or 0),
            "descubierto":    int(op.get("descubierto", 0) or 0),
            "open_interest":  int(op.get("open_interest", 0) or 0),
            "volume":         int(op.get("volume", 0) or 0),
        })

    if not filas:
        print(f"  ⚠️  Sin filas futuras en {fecha_informe}.")
        return

    exps = set(f["expiration"] for f in filas)
    sb = create_client(SB_URL, SB_KEY)
    try:
        sb.table(HIST_TABLE).upsert(filas, on_conflict="fecha_informe,expiration,strike,kind", ignore_duplicates=True).execute()
        print(f"  ✅ historico: {len(filas)} filas para {fecha_informe} (vtos: {', '.join(sorted(exps))}).")
    except Exception as e:
        print(f"  ❌ Error historico: {e}")

# ── Modo backfill ──────────────────────────────────────────────
def backfill(fecha_inicio: date, fecha_fin: date):
    print(f"\n📦 Backfill {fecha_inicio} → {fecha_fin}")
    total_ok, total_skip, total_err = 0, 0, 0

    dia = fecha_inicio
    while dia <= fecha_fin:
        if dia.weekday() >= 5:
            dia += timedelta(days=1)
            continue

        print(f"\n[{dia}]")
        pdf, fecha_real = descargar_pdf_exacto(dia)
        if not pdf:
            print(f"  ⚠️  PDF no disponible, saltando.")
            total_skip += 1
            dia += timedelta(days=1)
            continue

        try:
            data = procesar_con_claude(pdf)
            snapshot_historico(data, dia)
            total_ok += 1
        except Exception as e:
            print(f"  ❌ Error: {e}")
            total_err += 1

        dia += timedelta(days=1)

    print(f"\n✅ Backfill completo — OK:{total_ok}  Skip:{total_skip}  Errores:{total_err}")

# ── Main ───────────────────────────────────────────────────────
def main():
    if not all([ANTHROPIC_KEY, SB_URL, SB_KEY]):
        print("❌ Faltan variables de entorno (ANTHROPIC_KEY, SB_URL, SB_KEY)."); sys.exit(1)

    args = sys.argv[1:]

    # Modo backfill: --backfill 2026-03-23:2026-04-25
    if args and args[0] == "--backfill":
        if len(args) < 2 or ":" not in args[1]:
            print("Uso: --backfill YYYY-MM-DD:YYYY-MM-DD"); sys.exit(1)
        ini_str, fin_str = args[1].split(":", 1)
        backfill(date.fromisoformat(ini_str), date.fromisoformat(fin_str))
        return

    # Modo fecha puntual: --fecha 2026-04-10
    if args and args[0] == "--fecha":
        if len(args) < 2:
            print("Uso: --fecha YYYY-MM-DD"); sys.exit(1)
        fecha_obj = date.fromisoformat(args[1])
        print(f"🗓  Procesando fecha puntual: {fecha_obj}")
        pdf, fecha_real = descargar_pdf_exacto(fecha_obj)
        if not pdf:
            print("❌ PDF no encontrado."); sys.exit(1)
        data = procesar_con_claude(pdf)
        snapshot_historico(data, fecha_obj)
        return

    # Modo normal: dia de hoy
    print(f"🚀 Sincro IAMC — {datetime.now().strftime('%H:%M:%S')}")
    pdf, fecha = descargar_pdf(datetime.now())
    if not pdf:
        print("❌ PDF no encontrado."); sys.exit(1)
    try:
        data = procesar_con_claude(pdf)
        subir_a_supabase(data, fecha)
        snapshot_historico(data, fecha.date() if hasattr(fecha, 'date') else fecha)
    except Exception as e:
        print(f"❌ Fallo: {e}"); sys.exit(1)

if __name__ == "__main__":
    main()
