-- Tabla de caché para FINRA Short Interest
-- La edge function finra-si descarga el CSV de FINRA (~2MB, ~12k tickers)
-- y lo guarda aquí para consultas rápidas por ticker.
-- Se refresca automáticamente cada ~14 días cuando hay un nuevo settlement.

CREATE TABLE IF NOT EXISTS public.cache_finra_si (
  settlement_date text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz DEFAULT now()
);

-- Permitir que la edge function (service_role) inserte/actualice
-- El service_role bypass RLS por defecto
ALTER TABLE public.cache_finra_si ENABLE ROW LEVEL SECURITY;

-- Política: solo lectura para usuarios anónimos (vía API key)
-- La edge function usa service_role para escribir
CREATE POLICY "anon_read" ON public.cache_finra_si
  FOR SELECT USING (true);

CREATE POLICY "service_write" ON public.cache_finra_si
  FOR INSERT WITH CHECK (true);

CREATE POLICY "service_update" ON public.cache_finra_si
  FOR UPDATE USING (true);
