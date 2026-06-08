-- Dedup + log de alertas de spike de volumen (Fase C).
-- Clave (symbol, ts): se alerta una sola vez por base por snapshot.

create table if not exists public.opciones_flow_alertas (
  id         bigint generated always as identity primary key,
  symbol     text not null,
  ts         timestamptz not null,
  mercado    text,
  dvol       bigint,
  kind       text,
  strike     numeric,
  lado       text,
  cond_desc  text,
  enviado    boolean,
  fired_at   timestamptz not null default now()
);

create unique index if not exists uq_oflowalert_symbol_ts on public.opciones_flow_alertas (symbol, ts);
create index if not exists idx_oflowalert_fired on public.opciones_flow_alertas (fired_at desc);

alter table public.opciones_flow_alertas enable row level security;
drop policy if exists "oflowalert_read" on public.opciones_flow_alertas;
create policy "oflowalert_read" on public.opciones_flow_alertas for select using (true);
