-- ══════════════════════════════════════════════════
-- TABLA: portafolio — ejecutar en Supabase → SQL Editor
-- ══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS portafolio (
  id                uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_email        text        NOT NULL,
  tipo              text        NOT NULL,
  ticker_ars        text        NOT NULL,
  ticker_usd        text,
  ticker_adr        text,
  fecha_compra      date,
  cantidad          numeric     NOT NULL DEFAULT 0,
  precio_compra_ars numeric     NOT NULL,
  mep_compra        numeric     NOT NULL,
  precio_adr_compra numeric,
  ratio_cedear      text,
  stop_loss         numeric,
  activo            boolean     DEFAULT true,
  notas             text,
  created_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portafolio_user_email_idx ON portafolio (user_email);
CREATE INDEX IF NOT EXISTS portafolio_activo_idx     ON portafolio (activo);

-- RLS: lectura y escritura desde la anon key del dashboard
ALTER TABLE portafolio ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read"   ON portafolio FOR SELECT USING (true);
CREATE POLICY "anon_insert" ON portafolio FOR INSERT WITH CHECK (true);
CREATE POLICY "anon_update" ON portafolio FOR UPDATE USING (true);
CREATE POLICY "anon_delete" ON portafolio FOR DELETE USING (true);
