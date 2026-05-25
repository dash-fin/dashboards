#!/usr/bin/env python3
"""
backup.py — Dashboard Financiero
Genera un dump SQL restaurable (INSERT statements) de todas las tablas.

Uso:
    python3 backup.py

Requiere: Python 3.7+ (solo stdlib, sin dependencias externas)

Restauración:
    1. Ir al SQL Editor de Supabase
    2. Pegar el contenido del archivo .sql y ejecutar
    3. Las tablas se limpian y reinsertan en orden correcto (FK safe)

Frecuencia recomendada: semanal.
Datos críticos: portafolio, alertas.
Datos reconstituibles: mercado, mercado_usa (via scripts Python).
"""

import os
import json
import urllib.request
import urllib.error
from datetime import datetime, timedelta
from pathlib import Path

# Cargar .env.monitor automáticamente (mismo archivo que usan monitor_*.sh)
def _load_env_file():
    for p in [Path("/mnt/c/dashboard/Github/.env.monitor"),
              Path(__file__).parent.parent / ".env.monitor",
              Path("C:/Dashboard/Github/.env.monitor")]:
        try:
            if p.exists():
                for line in p.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
                return
        except Exception:
            pass
_load_env_file()

# ── Configuración ────────────────────────────────────────────────────
SB_URL        = "https://endymbpdayeidromxayb.supabase.co"
SB_KEY        = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVuZHltYnBkYXllaWRyb214YXliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MzU4NTAsImV4cCI6MjA4OTExMTg1MH0.BCZRvE9F1g_w2ffwj6NA6vyCYab2XcHDgmZir3CkeOk"
SB_MGMT_TOKEN = os.environ.get("SB_MGMT_TOKEN", "")  # via .env.monitor
PROJECT_NAME  = "Dashboard Financiero"
PROJECT_REF   = "endymbpdayeidromxayb"

# Orden INSERT: padres antes que hijos
TABLES_INSERT_ORDER = [
    "mercado",           # precios ARS — sin dependencias
    "mercado_usa",       # precios USD — sin dependencias
    "portafolio",        # posiciones  — sin dependencias ★ CRÍTICO
    "alertas",           # alertas activas                ★ CRÍTICO
    "alertas_historial", # → alertas (FK)
]

# Orden DELETE: hijos primero
TABLES_DELETE_ORDER = list(reversed(TABLES_INSERT_ORDER))

BATCH_SIZE = 1000


# ── REST API (PostgREST) ─────────────────────────────────────────────
def rest_get(table: str, limit: int, offset: int, order_col: str = "id") -> list:
    url = (
        f"{SB_URL}/rest/v1/{table}"
        f"?select=*&limit={limit}&offset={offset}&order={order_col}.asc.nullslast"
    )
    req = urllib.request.Request(
        url,
        headers={
            "apikey":        SB_KEY,
            "Authorization": f"Bearer {SB_KEY}",
            "Accept":        "application/json",
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError:
        # Reintentar sin ORDER BY (tabla sin columna id)
        url2 = f"{SB_URL}/rest/v1/{table}?select=*&limit={limit}&offset={offset}"
        req2 = urllib.request.Request(url2, headers={
            "apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}", "Accept": "application/json"
        })
        with urllib.request.urlopen(req2, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))


def rest_count(table: str) -> int:
    url = f"{SB_URL}/rest/v1/{table}?select=*&limit=1&offset=0"
    req = urllib.request.Request(
        url,
        headers={
            "apikey":        SB_KEY,
            "Authorization": f"Bearer {SB_KEY}",
            "Prefer":        "count=exact",
            "Accept":        "application/json",
        }
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        cr = resp.headers.get("Content-Range", "")
        if "/" in cr:
            return int(cr.split("/")[1])
        return 0


# ── Formateo de valores SQL ──────────────────────────────────────────
def sql_literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, (dict, list)):
        s = json.dumps(value, ensure_ascii=False, default=str)
        return "'" + s.replace("'", "''") + "'"
    return "'" + str(value).replace("'", "''") + "'"


# ── Dump de una tabla ────────────────────────────────────────────────
def dump_table(table: str) -> tuple:
    lines = []
    sep   = "─" * 52

    total = rest_count(table)

    lines.append(f"\n-- {sep}")
    lines.append(f"-- Tabla: {table}  ({total:,} filas)")
    lines.append(f"-- {sep}")

    if total == 0:
        lines.append("-- (sin datos)")
        return "\n".join(lines), 0

    inserted = 0
    offset   = 0
    cols     = None
    cols_sql = None

    while True:
        rows = rest_get(table, BATCH_SIZE, offset)
        if not rows:
            break

        if cols is None:
            cols     = list(rows[0].keys())
            cols_sql = ", ".join(f'"{c}"' for c in cols)

        for row in rows:
            vals = ", ".join(sql_literal(row.get(c)) for c in cols)
            lines.append(f'INSERT INTO "{table}" ({cols_sql}) VALUES ({vals});')
            inserted += 1

        offset += BATCH_SIZE
        if len(rows) < BATCH_SIZE:
            break

    return "\n".join(lines), inserted


# ── Verificar backup reciente ────────────────────────────────────────
def backup_reciente(script_dir: Path, now: datetime):
    for d in range(1, 7):
        fecha = (now - timedelta(days=d)).strftime("%Y-%m-%d")
        c = script_dir / fecha[:7] / f"{fecha}.sql"
        if c.exists():
            return c
    return None


# ── Scheduler backup (Windows + WSL + Supabase) ──────────────────────
def backup_schedulers(base_dir: Path) -> int:
    """Guarda inventario de tareas/crons en base_dir/schedulers/."""
    import subprocess
    print(f"\n  🕒  Schedulers")
    out_dir = base_dir / "schedulers"
    out_dir.mkdir(parents=True, exist_ok=True)
    count = 0

    # 1) Windows Task Scheduler — listado completo
    try:
        r = subprocess.run(
            ["schtasks.exe", "/query", "/fo", "LIST", "/v"],
            capture_output=True, text=True, encoding="cp1252", errors="replace", timeout=30
        )
        if r.returncode == 0 and r.stdout:
            (out_dir / "windows-tasks.txt").write_text(r.stdout, encoding="utf-8")
            print(f"     📋 windows-tasks.txt        {len(r.stdout)//1024} KB")
            count += 1
    except Exception as e:
        print(f"     ⚠ windows-tasks: {e}")

    # 2) Windows tasks — XML completo de cada task del usuario (restore-ready)
    try:
        r = subprocess.run(
            ["schtasks.exe", "/query", "/fo", "csv"],
            capture_output=True, text=True, encoding="cp1252", errors="replace", timeout=30
        )
        if r.returncode == 0:
            xml_dir = out_dir / "windows-tasks-xml"
            xml_dir.mkdir(exist_ok=True)
            # Parse task names from CSV (first column)
            tasks = set()
            for line in r.stdout.splitlines()[1:]:
                if not line.strip(): continue
                name = line.split(",", 1)[0].strip('"')
                # Only top-level user tasks (no system tasks under \Microsoft\…)
                if name.startswith("\\") and not name.startswith("\\Microsoft"):
                    tasks.add(name)
            for tn in tasks:
                try:
                    rx = subprocess.run(
                        ["schtasks.exe", "/query", "/tn", tn, "/xml"],
                        capture_output=True, text=True, encoding="utf-16-le",
                        errors="replace", timeout=15
                    )
                    if rx.returncode == 0 and rx.stdout:
                        safe = tn.lstrip("\\").replace("\\", "_").replace(" ", "_") + ".xml"
                        (xml_dir / safe).write_text(rx.stdout, encoding="utf-8")
                except Exception:
                    pass
            n = len(list(xml_dir.glob("*.xml")))
            if n:
                print(f"     📄 windows-tasks-xml/       {n} tasks")
                count += n
    except Exception as e:
        print(f"     ⚠ windows-tasks-xml: {e}")

    # 3) WSL crontab
    try:
        r = subprocess.run(
            ["wsl.exe", "-e", "bash", "-c", "crontab -l 2>/dev/null"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15
        )
        if r.returncode == 0 and r.stdout.strip():
            (out_dir / "wsl-crontab.txt").write_text(r.stdout, encoding="utf-8")
            print(f"     🐧 wsl-crontab.txt          {len(r.stdout.splitlines())} líneas")
            count += 1
    except Exception as e:
        print(f"     ⚠ wsl-crontab: {e}")

    # 4) Supabase pg_cron jobs
    if SB_MGMT_TOKEN:
        try:
            payload = json.dumps({
                "query": "SELECT jobid, jobname, schedule, command, active FROM cron.job ORDER BY jobid;"
            }).encode()
            req = urllib.request.Request(
                f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query",
                data=payload,
                headers={
                    "Authorization": f"Bearer {SB_MGMT_TOKEN}",
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (DashboardBackup/1.0)",
                }
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                jobs = json.loads(resp.read().decode("utf-8"))
            (out_dir / "supabase-crons.json").write_text(
                json.dumps(jobs, indent=2, default=str), encoding="utf-8"
            )
            print(f"     ☁  supabase-crons.json      {len(jobs)} jobs")
            count += 1
        except Exception as e:
            print(f"     ⚠ supabase-crons: {e}")

    return count


# ── Edge Functions backup ────────────────────────────────────────────
def list_edge_functions() -> list:
    """Lista todas las edge functions del proyecto via Management API."""
    url = f"https://api.supabase.com/v1/projects/{PROJECT_REF}/functions"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {SB_MGMT_TOKEN}",
        "User-Agent": "Mozilla/5.0 (DashboardBackup/1.0)",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_edge_function_source(slug: str) -> str:
    """
    Baja el ESZIP de una function y extrae el TypeScript original.
    Busca todos los JSON {"version":3,...} embebidos (source maps) y
    los une — uno por archivo del bundle.
    """
    url = f"https://api.supabase.com/v1/projects/{PROJECT_REF}/functions/{slug}/body"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {SB_MGMT_TOKEN}",
        "User-Agent": "Mozilla/5.0 (DashboardBackup/1.0)",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()

    # Scan por JSON balanceados que arrancan con {"version":3
    needle = b'{"version":3'
    out = []
    pos = 0
    while True:
        start = data.find(needle, pos)
        if start < 0:
            break
        # Balanceo de llaves para encontrar el cierre del JSON
        depth = 0
        i = start
        in_str = False
        esc = False
        end = -1
        while i < len(data):
            c = data[i:i+1]
            if esc:
                esc = False
            elif c == b'\\' and in_str:
                esc = True
            elif c == b'"':
                in_str = not in_str
            elif not in_str:
                if c == b'{':
                    depth += 1
                elif c == b'}':
                    depth -= 1
                    if depth == 0:
                        end = i + 1
                        break
            i += 1
        if end < 0:
            break
        chunk = data[start:end]
        try:
            sm = json.loads(chunk.decode("utf-8", errors="strict"))
            sources  = sm.get("sources", [])
            contents = sm.get("sourcesContent", [])
            for src_name, src_body in zip(sources, contents):
                if src_body and src_name and not src_name.startswith("https://"):
                    out.append(f"// ═══ {src_name} ═══\n{src_body}")
        except json.JSONDecodeError:
            pass
        pos = end

    if not out:
        return f"// ⚠ No se pudo extraer source del ESZIP de '{slug}' ({len(data)} bytes)\n"
    return "\n\n".join(out)


def backup_edge_functions(base_dir: Path) -> int:
    """Guarda el source de todas las edge functions en base_dir/edge-functions/."""
    print(f"\n  ⚡  Edge Functions")
    if not SB_MGMT_TOKEN:
        print(f"     ⏭  SB_MGMT_TOKEN no definida — salteando backup de edge functions")
        return 0
    out_dir = base_dir / "edge-functions"
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        fns = list_edge_functions()
    except Exception as e:
        print(f"     ❌ Error listando functions: {e}")
        return 0
    saved = 0
    for fn in fns:
        slug = fn.get("slug") or fn.get("name")
        if not slug:
            continue
        print(f"     📦 {slug:<28}", end="", flush=True)
        try:
            src = get_edge_function_source(slug)
            (out_dir / f"{slug}.ts").write_text(src, encoding="utf-8")
            kb = len(src.encode('utf-8')) / 1024
            print(f"  {kb:>6.1f} KB  ✓")
            saved += 1
        except Exception as e:
            print(f"  ERROR → {e}")
    # Manifest con versión deployada de cada function
    manifest = {fn.get("slug"): {"version": fn.get("version"), "status": fn.get("status"),
                                  "updated_at": fn.get("updated_at")} for fn in fns}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return saved


# ── Main ─────────────────────────────────────────────────────────────
def main():
    now = datetime.now()

    script_dir = Path(__file__).parent
    month_dir  = script_dir / now.strftime("%Y-%m")
    month_dir.mkdir(parents=True, exist_ok=True)
    out_file   = month_dir / f"{now.strftime('%Y-%m-%d')}.sql"

    print(f"\n{'═'*54}")
    print(f"  📈  Backup SQL — {PROJECT_NAME}")
    print(f"  📅  {now.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  📁  {out_file}")
    print(f"{'═'*54}\n")

    previo = backup_reciente(script_dir, now)
    if previo:
        print(f"  ℹ  Backup reciente encontrado: {previo.name}")
        print(f"     (frecuencia recomendada: semanal)\n")

    if out_file.exists():
        print("  ⚠  Ya existe backup para hoy. Sobreescribiendo...\n")

    header = f"""\
-- ╔══════════════════════════════════════════════════════════╗
-- ║  BACKUP SQL — {PROJECT_NAME:<44}║
-- ║  Proyecto  : {PROJECT_REF:<45}║
-- ║  Generado  : {now.strftime('%Y-%m-%d %H:%M:%S'):<45}║
-- ╚══════════════════════════════════════════════════════════╝
--
-- RESTAURACIÓN:
--   1. Abrir Supabase → SQL Editor del proyecto de destino
--   2. Pegar TODO el contenido de este archivo
--   3. Ejecutar — limpia y recarga los datos en orden FK-safe
--
-- DATO CRÍTICO: portafolio + alertas
-- RECONSTITUIBLE: mercado + mercado_usa (re-correr scripts Python)
--
-- TABLAS: {', '.join(TABLES_INSERT_ORDER)}
--

BEGIN;

-- ── Limpieza (hijos antes que padres) ─────────────────────────────
"""
    delete_block = "\n".join(f'DELETE FROM "{t}";' for t in TABLES_DELETE_ORDER) + "\n"

    table_blocks = []
    total_rows   = 0

    for table in TABLES_INSERT_ORDER:
        print(f"  📋  {table:<28}", end="", flush=True)
        try:
            block, count = dump_table(table)
            table_blocks.append(block)
            total_rows  += count
            print(f"  {count:>7,} filas  ✓")
        except Exception as exc:
            print(f"  ERROR → {exc}")
            table_blocks.append(f'\n-- ⚠ ERROR en "{table}": {exc}')

    footer = f"""

COMMIT;

-- ── Fin del backup ────────────────────────────────────────────────
-- Total filas : {total_rows:,}
-- Frecuencia  : semanal
"""

    full_sql = header + delete_block + "\n".join(table_blocks) + footer
    out_file.write_text(full_sql, encoding="utf-8")

    size_kb = out_file.stat().st_size / 1024
    print(f"\n{'═'*54}")
    print(f"  ✅  Backup SQL completado")
    print(f"  📄  {out_file.name}")
    print(f"  💾  {size_kb:.1f} KB  —  {total_rows:,} filas")
    print(f"{'═'*54}")

    # Edge functions: guardar en carpeta del mes, una sola vez por día
    fn_count = backup_edge_functions(month_dir)
    print(f"\n  ⚡  {fn_count} edge functions respaldadas en {month_dir / 'edge-functions'}")

    # Schedulers (Windows tasks + WSL crontab + Supabase pg_cron)
    sch_count = backup_schedulers(month_dir)
    print(f"  🕒  {sch_count} entradas respaldadas en {month_dir / 'schedulers'}")
    print(f"{'═'*54}\n")


if __name__ == "__main__":
    main()
