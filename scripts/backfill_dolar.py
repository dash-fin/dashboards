"""
backfill_dolar.py — Backfill dolar_historico en Supabase.

Carga:
  1. Dólar oficial   → desde ArgentinaDatos API
  2. MEP             → desde mep_historico (tabla existente)
  3. CCL             → desde Rava (AL30C / AL30)

Uso: python backfill_dolar.py
"""
import os, sys, json, time
from datetime import datetime, date, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP

import requests

# ── Config ─────────────────────────────────────────────────────
SUPABASE_URL = 'https://endymbpdayeidromxayb.supabase.co'
# Read from environment variables (never hardcode secrets in repo)
SUPABASE_KEY = os.environ.get('SUPABASE_ANON_KEY', '')
SB_SECRET = os.environ.get('SUPABASE_SECRET_KEY', '')

SB_HEADERS = {
    'apikey':        SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type':  'application/json',
    'Prefer':        'resolution=merge-duplicates,return=minimal',
}

# Headers to call edge functions (need service role)
EDGE_HEADERS = {
    'apikey':        SB_SECRET,
    'Authorization': f'Bearer {SB_SECRET}',
    'Content-Type':  'application/json',
}

USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'


def log(msg):
    print(f'  [{datetime.now().strftime("%H:%M:%S")}] {msg}')


def round2(val):
    """Round a number to 2 decimal places."""
    return float(Decimal(str(val)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))


# ── Supabase helpers ──────────────────────────────────────────

def get_existing_dates(tipo):
    """Return set of existing (fecha,) tuples for a given tipo."""
    url = f'{SUPABASE_URL}/rest/v1/dolar_historico'
    params = {
        'select': 'fecha',
        'tipo': f'eq.{tipo}',
        'limit': 50000,
    }
    r = requests.get(url, headers={**SB_HEADERS, 'Prefer': ''}, params=params, timeout=30)
    if not r.ok:
        log(f'Error fetching existing {tipo}: {r.status_code} {r.text[:100]}')
        return set()
    return set(row['fecha'] for row in r.json())


def get_mep_historico(since):
    """Return all MEP rows from mep_historico."""
    url = f'{SUPABASE_URL}/rest/v1/mep_historico'
    params = {
        'select': 'fecha,mep',
        'fecha': f'gte.{since}',
        'order': 'fecha.asc',
        'limit': 50000,
    }
    r = requests.get(url, headers={**SB_HEADERS, 'Prefer': ''}, params=params, timeout=30)
    if not r.ok:
        log(f'Error fetching mep_historico: {r.status_code} {r.text[:100]}')
        return []
    return r.json()


def upsert_dolar(records):
    """Insert records into dolar_historico (skips conflicts)."""
    if not records:
        return 0
    total = 0
    for i in range(0, len(records), 500):
        chunk = records[i:i + 500]
        r = requests.post(
            f'{SUPABASE_URL}/rest/v1/dolar_historico',
            headers=SB_HEADERS,
            data=json.dumps(chunk),
            timeout=30,
        )
        if r.status_code in (200, 201, 204):
            total += len(chunk)
        else:
            log(f'Supabase error: {r.status_code} {r.text[:120]}')
            # If it's a conflict error for existing rows, that's OK
            if 'duplicate key' in r.text.lower() or 'conflict' in r.text.lower():
                total += len(chunk)  # at least attempted
        time.sleep(0.05)
    return total


# ── 1. Dólar oficial ──────────────────────────────────────────

def fetch_oficial(since_date):
    """Fetch dólar oficial from ArgentinaDatos, filter from since_date."""
    url = 'https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial'
    r = requests.get(url, headers={'User-Agent': USER_AGENT}, timeout=30)
    if r.status_code != 200:
        log(f'ArgentinaDatos error: {r.status_code}')
        return []
    data = r.json()
    # Each item: {"fecha": "2025-05-05", "compra": X, "venta": Y}
    records = []
    for item in data:
        f = item.get('fecha', '')
        if f and f >= since_date and item.get('venta'):
            records.append({
                'fecha': f,
                'tipo': 'oficial',
                'close': round2(item['venta']),
                'fuente': 'argentinadatos',
            })
    return records


# ── 2. MEP ────────────────────────────────────────────────────

def fetch_mep(since_date):
    """Get MEP data from mep_historico table."""
    rows = get_mep_historico(since_date)
    records = []
    for row in rows:
        if row.get('mep') and row['mep'] > 0:
            records.append({
                'fecha': row['fecha'],
                'tipo': 'mep',
                'close': round2(row['mep']),
                'fuente': 'rava',
            })
    return records


# ── 3. CCL ────────────────────────────────────────────────────

def fetch_ccl(since_date, existing_dates):
    """Calculate CCL = AL30C close / AL30 close from Rava data.

    Uses the yahoo-prices edge function to get Rava series for AL30 and AL30C.
    """
    log('Fetching AL30 and AL30C from Rava...')
    url = f'{SUPABASE_URL}/functions/v1/yahoo-prices'
    body = json.dumps({'mode': 'rava-series', 'symbols': ['AL30', 'AL30C']})

    r = requests.post(url, headers=EDGE_HEADERS, data=body, timeout=60)
    if r.status_code != 200:
        log(f'Edge function error: {r.status_code} {r.text[:200]}')
        return []

    data = r.json()
    # data is a dict: { "AL30": [...rows with especie, fecha, cierre...],
    #                   "AL30C": [...] }
    al30_raw = data.get('AL30', [])
    al30c_raw = data.get('AL30C', [])

    # Build price index by fecha for AL30 and AL30C
    # Each row has "fecha" and "cierre"
    # For AL30: we want CIERRE (in ARS), typically from CT (contado) settlement
    al30_idx = {}
    for item in al30_raw:
        f = item.get('fecha', '')
        c = item.get('cierre')
        especie = item.get('especie', '')
        if f and c and c > 0:
            # Prefer CT (contado) over SB (simultáneo) — CT has volume
            if f not in al30_idx or 'CT' in especie:
                al30_idx[f] = float(c)

    al30c_idx = {}
    for item in al30c_raw:
        f = item.get('fecha', '')
        c = item.get('cierre')
        especie = item.get('especie', '')
        if f and c and c > 0:
            # Prefer CT (contado) over SB/EXT
            if f not in al30c_idx or 'CT' in especie:
                al30c_idx[f] = float(c)

    log(f'  AL30: {len(al30_idx)} fechas  AL30C: {len(al30c_idx)} fechas')

    # Merge dates where both have data
    all_dates = sorted(set(al30_idx.keys()) & set(al30c_idx.keys()))
    log(f'  Fechas con ambos: {len(all_dates)}  ({all_dates[0] if all_dates else "N/A"} → {all_dates[-1] if all_dates else "N/A"})')

    records = []
    for f in all_dates:
        if f < since_date:
            continue
        if f in existing_dates:
            continue

        al30_px = al30_idx[f]
        al30c_px = al30c_idx[f]
        if al30_px <= 0 or al30c_px <= 0:
            continue

        # CCL = AL30 (ARS) / AL30C (USD)
        # Compra AL30 en ARS, vende AL30C en USD → cotización implícita
        ccl = round2(al30_px / al30c_px)
        records.append({
            'fecha': f,
            'tipo': 'ccl',
            'close': ccl,
            'fuente': 'rava',
        })

    return records


# ── Main ──────────────────────────────────────────────────────

def main():
    print('=' * 60)
    print('Backfill dolar_historico')
    print('=' * 60)

    # Determine start date: earliest MEP date in mep_historico
    mep_start = get_mep_historico('2000-01-01')
    if not mep_start:
        # Fallback: 1 year ago
        since = (date.today() - timedelta(days=365)).isoformat()
        log(f'No MEP data found, starting from {since}')
    else:
        earliest = min(r['fecha'] for r in mep_start if r.get('fecha'))
        since = earliest
        log(f'Earliest MEP data: {since}')

    # ── 1. Dólar oficial ──
    log('')
    log('─' * 40)
    log('1. Dólar oficial (ArgentinaDatos)')
    existing_of = get_existing_dates('oficial')
    log(f'   Ya existen {len(existing_of)} registros')
    of_records = fetch_oficial(since)
    # Filter out existing
    of_new = [r for r in of_records if r['fecha'] not in existing_of]
    log(f'   Obtenidos {len(of_records)}, nuevos: {len(of_new)}')
    if of_new:
        inserted = upsert_dolar(of_new)
        log(f'   Insertados: {inserted}')
    else:
        log('   Sin novedades')

    # ── 2. MEP ──
    log('')
    log('─' * 40)
    log('2. MEP (desde mep_historico)')
    existing_mep = get_existing_dates('mep')
    log(f'   Ya existen {len(existing_mep)} registros')
    mep_records = fetch_mep(since)
    mep_new = [r for r in mep_records if r['fecha'] not in existing_mep]
    log(f'   Obtenidos {len(mep_records)}, nuevos: {len(mep_new)}')
    if mep_new:
        inserted = upsert_dolar(mep_new)
        log(f'   Insertados: {inserted}')
    else:
        log('   Sin novedades')

    # ── 3. CCL ──
    log('')
    log('─' * 40)
    log('3. CCL (AL30C/AL30 desde Rava)')
    existing_ccl = get_existing_dates('ccl')
    log(f'   Ya existen {len(existing_ccl)} registros')
    ccl_records = fetch_ccl(since, existing_ccl)
    log(f'   Nuevos: {len(ccl_records)}')
    if ccl_records:
        inserted = upsert_dolar(ccl_records)
        log(f'   Insertados: {inserted}')
    else:
        log('   Sin novedades')

    # ── Summary ──
    log('')
    log('=' * 60)
    log('Resumen final')

    for t in ('oficial', 'mep', 'ccl'):
        existing = get_existing_dates(t)
        if existing:
            dates = sorted(existing)
            log(f'  {t}: {len(dates)} registros ({dates[0]} → {dates[-1]})')
        else:
            log(f'  {t}: 0 registros')

    log('')
    log('Backfill completado.')


if __name__ == '__main__':
    main()
