-- Serie temporal de flujo de opciones GGAL (local ARS + USA ADR).
-- Append puro: cada snapshot (~cada 5 min en horario de mercado) inserta filas, no se pisa.
-- Fuente local: monitor_rt.py (pyhomebroker). Fuente USA: alpaca_usa.py (Yahoo chain).

create table if not exists public.opciones_flow (
  id          bigint generated always as identity primary key,
  ts          timestamptz not null default now(),
  mercado     text not null,            -- 'local' | 'usa'
  underlying  text not null default 'GGAL',
  symbol      text not null,
  expiration  date,
  strike      numeric,
  kind        text,                     -- 'call' | 'put'
  last        numeric,
  bid         numeric,
  ask         numeric,
  volume      bigint,                   -- acumulado del dia
  operations  integer,
  oi          bigint,
  price_underlying numeric
);

create index if not exists idx_oflow_mercado_ts on public.opciones_flow (mercado, ts);
create index if not exists idx_oflow_symbol_ts  on public.opciones_flow (symbol, ts);

alter table public.opciones_flow enable row level security;

drop policy if exists "oflow_read" on public.opciones_flow;
create policy "oflow_read" on public.opciones_flow for select using (true);
