-- ══════════════════════════════════════════════════
-- TABLA: portafolio
-- Ejecutar en Supabase → SQL Editor
-- ══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS portafolio (
  id               uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_email       text        NOT NULL,
  tipo             text        NOT NULL,   -- CEDEAR | BONO_SOBERANO | DOLAR_LINKED | BONO_CER | BONO_DUAL | ACCION
  ticker_ars       text        NOT NULL,   -- ticker en ARS (ej. PG, AL30, MRCAO)
  ticker_usd       text,                   -- ticker en USD (ej. PGD, AL30D, MRCAD)
  ticker_adr       text,                   -- ticker ADR para CEDEARs (ej. PG, MELI)
  fecha_compra     date,
  cantidad         numeric     NOT NULL DEFAULT 0,   -- nominales (bonos) o acciones (CEDEARs)
  precio_compra_ars numeric   NOT NULL,
  mep_compra       numeric    NOT NULL,   -- MEP vigente al momento de la compra
  precio_adr_compra numeric,              -- precio ADR al momento de la compra
  ratio_cedear     text,                   -- ratio CEDEAR:ADR (ej. '15', '120')
  stop_loss        numeric,
  activo           boolean     DEFAULT true,
  notas            text,
  created_at       timestamptz DEFAULT now()
);

-- Índices útiles
CREATE INDEX IF NOT EXISTS portafolio_user_email_idx ON portafolio (user_email);
CREATE INDEX IF NOT EXISTS portafolio_tipo_idx        ON portafolio (tipo);
CREATE INDEX IF NOT EXISTS portafolio_activo_idx      ON portafolio (activo);

-- RLS: lectura pública (el dashboard usa anon key, los datos no son sensibles)
ALTER TABLE portafolio ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read" ON portafolio FOR SELECT USING (true);
