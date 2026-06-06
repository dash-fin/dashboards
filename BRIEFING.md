# BRIEFING TÉCNICO — Sistema de Gestión Cooperadora J.I. Nº 923

> **Instrucciones para Windsurf:**
> - Si hay SQL, código o comandos con forma definida → **ejecutalos directamente, sin explicar lo que vas a hacer**.
> - Si hay ambigüedad real, una decisión de arquitectura con trade-offs, o algo que puede romper datos existentes → **preguntá antes de actuar**.
> - El criterio es: *menos charla, más código*.

---

## 0. Contexto del proyecto

Migración de un sistema de gestión escolar que hoy corre en Google Sheets + Google Apps Script a una aplicación web moderna. El cliente es la Cooperadora del Jardín de Infantes Nº 923 (Buenos Aires, Argentina).

**Lo que hace el sistema (ya mapeado y analizado):**

| Módulo | Descripción |
|--------|-------------|
| Cobros | Registra pagos de cuotas, materiales, cuaderno y emergencias por alumno. Genera recibo automático compartible por WhatsApp. |
| Movimientos | Ingresos y egresos generales con foto de comprobante subida a Storage. |
| Socios y Morosidad | Estado de cuenta por alumno, lista de morosos, envío de recordatorio por WhatsApp. |
| Eventos y Rifas | Crea eventos de recaudación, registra ventas por sala, cierra con balance. |
| Pagos Digitales | Integración con MercadoPago: link/QR de pago, registro automático vía webhook. |
| Balance Mensual/Anual | Tabla de entradas/salidas, exportable como PDF firmable para asamblea. |
| Inicio de Ciclo | Wizard para configurar nuevo ciclo lectivo: fechas, precios, importar alumnos. |
| Auditoría | Log completo de acciones: quién registró qué, cuándo, desde qué IP. |
| Portal Familiar | Login read-only para que el familiar vea el estado de pagos de su hijo/a. |

**Archivos de referencia de diseño** (en la raíz del repo, abrirlos en browser):
- `mock-cooperadora-v2.html` → ERP web completo (referencia de UI/UX y flujos)
- `mock-android.html` → referencia de app Android (futuro, no implementar ahora)

**El sistema existente (Google Sheets) sigue funcionando** durante la migración. El nuevo sistema arranca limpio para el ciclo 2026/2027; la migración de datos históricos es una tarea separada que NO está en este scope.

---

## 1. Stack técnico

```
Next.js 14 (App Router + TypeScript)
Tailwind CSS + shadcn/ui
Supabase: PostgreSQL + Auth + Storage + RLS
Vercel: deploy automático desde main
GitHub: repo dash-fin/dashboards, GitHub Flow
@react-pdf/renderer: generación de PDF
mercadopago: SDK oficial de MP para Node.js
```

---

## 2. Setup inicial

### 2.1 Repositorio GitHub
El repo ya existe: `dash-fin/dashboards`. La rama de desarrollo activa es `claude/online-status-check-rlKOo`. Crear la siguiente estructura de branching:
- `main` → producción, auto-deploy a Vercel
- `develop` → integración
- `feat/*` → features individuales

### 2.2 Next.js — Scaffolding inicial
Ejecutar en la raíz del repo:

```bash
npx create-next-app@14 . --typescript --tailwind --eslint --app --src-dir=false --import-alias="@/*" --yes
```

Luego instalar dependencias:

```bash
npm install @supabase/supabase-js @supabase/ssr
npm install @radix-ui/react-slot class-variance-authority clsx tailwind-merge lucide-react
npx shadcn@latest init
npx shadcn@latest add button card table badge select input label dialog sheet tabs progress avatar separator toast dropdown-menu
npm install @react-pdf/renderer
npm install mercadopago
npm install recharts
npm install date-fns
npm install sonner
```

### 2.3 Proyecto Supabase
Crear proyecto en `supabase.com` con región `sa-east-1` (São Paulo, la más cercana a Argentina). Guardar:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

### 2.4 Vercel
Conectar el repo `dash-fin/dashboards` a Vercel. Rama de producción: `main`. Configurar las env vars listadas en la sección 3.

### 2.5 Variables de entorno
Crear `.env.local` con:

```env
NEXT_PUBLIC_SUPABASE_URL=<tu-url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<tu-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
MP_ACCESS_TOKEN=<mercadopago-access-token>
MP_WEBHOOK_SECRET=<webhook-secret-de-mp>
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

En Vercel, cargar las mismas variables con los valores de producción.

---

## 3. Base de datos — SQL a ejecutar en Supabase

Ejecutar el siguiente bloque completo en el SQL Editor de Supabase en este orden exacto.

### 3.1 Tablas

```sql
-- Extensiones
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── CICLOS LECTIVOS ────────────────────────────────────────────
CREATE TABLE ciclos_lectivos (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre       TEXT NOT NULL,
  fecha_inicio DATE NOT NULL,
  fecha_fin    DATE NOT NULL,
  activo       BOOLEAN DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_solo_un_ciclo_activo ON ciclos_lectivos (activo) WHERE activo = true;

-- ── SALAS ──────────────────────────────────────────────────────
CREATE TABLE salas (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre           TEXT NOT NULL,
  turno            TEXT CHECK (turno IN ('mañana', 'tarde')),
  ciclo_lectivo_id UUID REFERENCES ciclos_lectivos(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── SOCIOS ─────────────────────────────────────────────────────
CREATE TABLE socios (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  numero           INTEGER,
  apellido         TEXT NOT NULL,
  nombre           TEXT NOT NULL,
  sala_id          UUID REFERENCES salas(id),
  ciclo_lectivo_id UUID REFERENCES ciclos_lectivos(id) ON DELETE CASCADE,
  activo           BOOLEAN DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_socios_ciclo ON socios(ciclo_lectivo_id);
CREATE INDEX idx_socios_sala  ON socios(sala_id);

-- ── CATEGORÍAS ─────────────────────────────────────────────────
CREATE TABLE categorias (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre     TEXT NOT NULL UNIQUE,
  tipo       TEXT NOT NULL CHECK (tipo IN ('ingreso', 'egreso')),
  grupo      TEXT,
  activo     BOOLEAN DEFAULT true,
  sistema    BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── PRECIOS POR CICLO ──────────────────────────────────────────
CREATE TABLE precios_ciclo (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ciclo_lectivo_id UUID REFERENCES ciclos_lectivos(id) ON DELETE CASCADE,
  concepto         TEXT NOT NULL,
  monto            DECIMAL(10,2) NOT NULL,
  mes_inicio       INTEGER,
  mes_fin          INTEGER,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── MOVIMIENTOS ────────────────────────────────────────────────
CREATE TABLE movimientos (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fecha            DATE NOT NULL DEFAULT CURRENT_DATE,
  descripcion      TEXT NOT NULL,
  nro_comprobante  TEXT,
  categoria_id     UUID REFERENCES categorias(id),
  tipo             TEXT NOT NULL CHECK (tipo IN ('ingreso', 'egreso')),
  monto            DECIMAL(10,2) NOT NULL CHECK (monto > 0),
  comprobante_url  TEXT,
  ciclo_lectivo_id UUID REFERENCES ciclos_lectivos(id),
  registrado_por   UUID REFERENCES auth.users(id),
  fuente           TEXT DEFAULT 'manual' CHECK (fuente IN ('manual', 'mercadopago', 'importacion')),
  mp_payment_id    TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_mov_fecha  ON movimientos(fecha);
CREATE INDEX idx_mov_ciclo  ON movimientos(ciclo_lectivo_id);
CREATE INDEX idx_mov_tipo   ON movimientos(tipo);
CREATE INDEX idx_mov_cat    ON movimientos(categoria_id);

-- ── PAGOS DE SOCIOS ────────────────────────────────────────────
CREATE TABLE pagos_socios (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  socio_id         UUID NOT NULL REFERENCES socios(id) ON DELETE CASCADE,
  ciclo_lectivo_id UUID NOT NULL REFERENCES ciclos_lectivos(id),
  periodo          TEXT NOT NULL,  -- "2026-03"
  concepto         TEXT NOT NULL,  -- "cuota" | "materiales" | "cuaderno" | "emergencia_0"..."emergencia_4"
  monto            DECIMAL(10,2) NOT NULL,
  movimiento_id    UUID REFERENCES movimientos(id),
  registrado_por   UUID REFERENCES auth.users(id),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (socio_id, periodo, concepto)
);
CREATE INDEX idx_pagos_socio   ON pagos_socios(socio_id);
CREATE INDEX idx_pagos_ciclo   ON pagos_socios(ciclo_lectivo_id);
CREATE INDEX idx_pagos_periodo ON pagos_socios(periodo);

-- ── RECIBOS ────────────────────────────────────────────────────
CREATE TABLE recibos (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  numero        BIGSERIAL UNIQUE,
  socio_id      UUID REFERENCES socios(id),
  monto_total   DECIMAL(10,2) NOT NULL,
  items         JSONB,   -- [{concepto, periodo, monto}]
  pdf_url       TEXT,
  movimiento_id UUID REFERENCES movimientos(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  created_by    UUID REFERENCES auth.users(id)
);

-- ── PERFILES DE USUARIO ────────────────────────────────────────
CREATE TABLE perfiles (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  nombre_completo TEXT,
  rol             TEXT NOT NULL DEFAULT 'lector'
                  CHECK (rol IN ('admin', 'tesorero', 'vocal', 'lector', 'familiar')),
  socio_id        UUID REFERENCES socios(id),
  activo          BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-crear perfil al registrarse
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO perfiles (id, nombre_completo, rol)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name', 'lector');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ── EVENTOS ────────────────────────────────────────────────────
CREATE TABLE eventos (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre           TEXT NOT NULL,
  tipo             TEXT CHECK (tipo IN ('rifa', 'kermesse', 'festival', 'otro')),
  fecha            DATE,
  precio_unidad    DECIMAL(10,2),
  total_unidades   INTEGER,
  ciclo_lectivo_id UUID REFERENCES ciclos_lectivos(id),
  estado           TEXT DEFAULT 'activo' CHECK (estado IN ('activo', 'cerrado', 'archivado')),
  notas            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  created_by       UUID REFERENCES auth.users(id)
);

CREATE TABLE ventas_evento (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  evento_id      UUID REFERENCES eventos(id) ON DELETE CASCADE,
  sala_id        UUID REFERENCES salas(id),
  cantidad       INTEGER NOT NULL CHECK (cantidad > 0),
  monto_total    DECIMAL(10,2) NOT NULL,
  registrado_por UUID REFERENCES auth.users(id),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── AUDITORÍA ──────────────────────────────────────────────────
CREATE TABLE auditoria (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id  UUID REFERENCES auth.users(id),
  accion      TEXT NOT NULL,
  tabla       TEXT,
  registro_id UUID,
  detalle     JSONB,
  ip          TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_usuario ON auditoria(usuario_id);
CREATE INDEX idx_audit_fecha   ON auditoria(created_at);
```

### 3.2 Función de auditoría automática

```sql
CREATE OR REPLACE FUNCTION registrar_auditoria(
  p_accion TEXT,
  p_tabla  TEXT DEFAULT NULL,
  p_id     UUID DEFAULT NULL,
  p_detalle JSONB DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  INSERT INTO auditoria (usuario_id, accion, tabla, registro_id, detalle)
  VALUES (auth.uid(), p_accion, p_tabla, p_id, p_detalle);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 3.3 Vista de morosidad

```sql
CREATE OR REPLACE VIEW v_morosidad AS
WITH ciclo_activo AS (
  SELECT id, fecha_inicio FROM ciclos_lectivos WHERE activo = true LIMIT 1
),
meses_transcurridos AS (
  SELECT generate_series(
    DATE_TRUNC('month', (SELECT fecha_inicio FROM ciclo_activo)),
    DATE_TRUNC('month', CURRENT_DATE),
    '1 month'::interval
  ) AS mes
),
pagos_cuota AS (
  SELECT socio_id, periodo
  FROM pagos_socios
  WHERE concepto = 'cuota'
    AND ciclo_lectivo_id = (SELECT id FROM ciclo_activo)
)
SELECT
  s.id AS socio_id,
  s.apellido,
  s.nombre,
  sa.nombre AS sala,
  sa.turno,
  COUNT(mt.mes) FILTER (WHERE pc.socio_id IS NULL) AS meses_sin_pagar,
  COUNT(mt.mes) FILTER (WHERE pc.socio_id IS NULL) *
    COALESCE((
      SELECT monto FROM precios_ciclo
      WHERE ciclo_lectivo_id = (SELECT id FROM ciclo_activo)
        AND concepto = 'cuota' LIMIT 1
    ), 0) AS deuda_estimada
FROM socios s
JOIN salas sa ON s.sala_id = sa.id
CROSS JOIN meses_transcurridos mt
LEFT JOIN pagos_cuota pc ON pc.socio_id = s.id
  AND TO_CHAR(mt.mes, 'YYYY-MM') = pc.periodo
WHERE s.ciclo_lectivo_id = (SELECT id FROM ciclo_activo)
  AND s.activo = true
GROUP BY s.id, s.apellido, s.nombre, sa.nombre, sa.turno
HAVING COUNT(mt.mes) FILTER (WHERE pc.socio_id IS NULL) > 0
ORDER BY meses_sin_pagar DESC, s.apellido;
```

### 3.4 Row Level Security (RLS)

```sql
-- Habilitar RLS en todas las tablas
ALTER TABLE ciclos_lectivos ENABLE ROW LEVEL SECURITY;
ALTER TABLE salas            ENABLE ROW LEVEL SECURITY;
ALTER TABLE socios           ENABLE ROW LEVEL SECURITY;
ALTER TABLE categorias       ENABLE ROW LEVEL SECURITY;
ALTER TABLE precios_ciclo    ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimientos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagos_socios     ENABLE ROW LEVEL SECURITY;
ALTER TABLE recibos          ENABLE ROW LEVEL SECURITY;
ALTER TABLE perfiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventos          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ventas_evento    ENABLE ROW LEVEL SECURITY;
ALTER TABLE auditoria        ENABLE ROW LEVEL SECURITY;

-- Helper: obtener rol del usuario actual
CREATE OR REPLACE FUNCTION mi_rol()
RETURNS TEXT AS $$
  SELECT rol FROM perfiles WHERE id = auth.uid() AND activo = true;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Helper: obtener socio_id del familiar
CREATE OR REPLACE FUNCTION mi_socio_id()
RETURNS UUID AS $$
  SELECT socio_id FROM perfiles WHERE id = auth.uid() AND rol = 'familiar';
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- POLICIES: Acceso por rol
-- admin y tesorero: acceso total
-- vocal: SELECT + INSERT, no DELETE
-- lector: solo SELECT
-- familiar: solo SELECT de sus propios datos

DO $$
DECLARE
  t TEXT;
  tablas TEXT[] := ARRAY['ciclos_lectivos','salas','categorias','precios_ciclo',
                          'movimientos','eventos','ventas_evento'];
BEGIN
  FOREACH t IN ARRAY tablas LOOP
    EXECUTE format('CREATE POLICY "staff_all" ON %I FOR ALL USING (mi_rol() IN (''admin'',''tesorero''));', t);
    EXECUTE format('CREATE POLICY "vocal_read_insert" ON %I FOR SELECT USING (mi_rol() IN (''vocal'',''lector''));', t);
    EXECUTE format('CREATE POLICY "vocal_insert" ON %I FOR INSERT WITH CHECK (mi_rol() = ''vocal'');', t);
  END LOOP;
END $$;

-- socios: familiar solo ve el suyo
CREATE POLICY "staff_socios"    ON socios FOR ALL    USING (mi_rol() IN ('admin','tesorero'));
CREATE POLICY "lector_socios"   ON socios FOR SELECT USING (mi_rol() IN ('vocal','lector'));
CREATE POLICY "vocal_socios"    ON socios FOR INSERT WITH CHECK (mi_rol() = 'vocal');
CREATE POLICY "familiar_socio"  ON socios FOR SELECT USING (id = mi_socio_id());

-- pagos_socios: familiar solo ve los suyos
CREATE POLICY "staff_pagos"    ON pagos_socios FOR ALL    USING (mi_rol() IN ('admin','tesorero'));
CREATE POLICY "lector_pagos"   ON pagos_socios FOR SELECT USING (mi_rol() IN ('vocal','lector'));
CREATE POLICY "vocal_pagos"    ON pagos_socios FOR INSERT WITH CHECK (mi_rol() = 'vocal');
CREATE POLICY "familiar_pagos" ON pagos_socios FOR SELECT USING (socio_id = mi_socio_id());

-- recibos: familiar solo ve los suyos
CREATE POLICY "staff_recibos"    ON recibos FOR ALL    USING (mi_rol() IN ('admin','tesorero'));
CREATE POLICY "lector_recibos"   ON recibos FOR SELECT USING (mi_rol() IN ('vocal','lector'));
CREATE POLICY "familiar_recibos" ON recibos FOR SELECT USING (socio_id = mi_socio_id());

-- perfiles: cada usuario ve el suyo; admin ve todos
CREATE POLICY "admin_perfiles"    ON perfiles FOR ALL    USING (mi_rol() = 'admin');
CREATE POLICY "propio_perfil"     ON perfiles FOR SELECT USING (id = auth.uid());
CREATE POLICY "staff_perfiles_r"  ON perfiles FOR SELECT USING (mi_rol() IN ('tesorero','vocal','lector'));

-- auditoria: solo admin y tesorero
CREATE POLICY "staff_auditoria" ON auditoria FOR ALL USING (mi_rol() IN ('admin','tesorero'));
```

### 3.5 Datos semilla

```sql
-- Ciclo lectivo activo
INSERT INTO ciclos_lectivos (nombre, fecha_inicio, fecha_fin, activo)
VALUES ('2025/2026', '2025-05-01', '2026-04-30', true);

-- Guardar el ID del ciclo para usarlo abajo
DO $$
DECLARE ciclo_id UUID;
BEGIN
  SELECT id INTO ciclo_id FROM ciclos_lectivos WHERE activo = true;

  -- Salas
  INSERT INTO salas (nombre, turno, ciclo_lectivo_id) VALUES
    ('Celeste Mañana',  'mañana', ciclo_id),
    ('Roja Mañana',     'mañana', ciclo_id),
    ('Naranja Mañana',  'mañana', ciclo_id),
    ('Verde Mañana',    'mañana', ciclo_id),
    ('Celeste Tarde',   'tarde',  ciclo_id),
    ('Roja Tarde',      'tarde',  ciclo_id),
    ('Naranja Tarde',   'tarde',  ciclo_id),
    ('Verde Tarde',     'tarde',  ciclo_id);

  -- Precios del ciclo activo
  INSERT INTO precios_ciclo (ciclo_lectivo_id, concepto, monto, mes_inicio, mes_fin) VALUES
    (ciclo_id, 'cuota',              3000, 3,  4),   -- Mar y Abr: $3.000
    (ciclo_id, 'cuota',              4000, 5,  12),  -- May a Dic: $4.000
    (ciclo_id, 'materiales',         7000, NULL, NULL),
    (ciclo_id, 'cuaderno',           4000, NULL, NULL),
    (ciclo_id, 'emergencia_unica',  20000, NULL, NULL),
    (ciclo_id, 'emergencia_cuota',   5000, NULL, NULL);

END $$;

-- Categorías base (sistema = true → no se pueden borrar)
INSERT INTO categorias (nombre, tipo, grupo, sistema) VALUES
  -- INGRESOS
  ('Cuota Social',              'ingreso', 'Recursos Propios',    true),
  ('Materiales',                'ingreso', 'Recursos Propios',    true),
  ('Cuaderno',                  'ingreso', 'Recursos Propios',    true),
  ('Emergencias',               'ingreso', 'Recursos Propios',    true),
  ('Bono Contribución',         'ingreso', 'Recursos Propios',    true),
  ('Rifas',                     'ingreso', 'Recursos Propios',    true),
  ('Festival/Evento/Quermese',  'ingreso', 'Recursos Propios',    true),
  ('Kiosco',                    'ingreso', 'Recursos Propios',    true),
  ('Subsidio Municipio',        'ingreso', 'Recursos Oficiales',  true),
  ('Subsidio Provincial',       'ingreso', 'Recursos Oficiales',  true),
  ('Donaciones',                'ingreso', 'Otros',               true),
  ('Otros Ingresos',            'ingreso', 'Otros',               true),
  -- EGRESOS
  ('Gastos Alumno - Golosinas/Medallas', 'egreso', 'Gastos para el alumno', true),
  ('Gastos Alumno - Fotocopias',         'egreso', 'Gastos para el alumno', true),
  ('Gastos Alumno - Librería/Útiles',    'egreso', 'Gastos para el alumno', true),
  ('Gastos Alumno - Excursiones',        'egreso', 'Gastos para el alumno', true),
  ('Gastos Alumno - Ropa y Calzado',     'egreso', 'Gastos para el alumno', true),
  ('Gastos Escuela - Material Didáctico','egreso', 'Gastos para la escuela',true),
  ('Gastos Escuela - Mantenimiento/Mejoras','egreso','Gastos para la escuela',true),
  ('Gastos Escuela - Art. Limpieza',     'egreso', 'Gastos para la escuela',true),
  ('Gastos Escuela - Ferretería',        'egreso', 'Gastos para la escuela',true),
  ('Gastos Escuela - Mat. Eléctrico',    'egreso', 'Gastos para la escuela',true),
  ('Gastos Escuela - Librería/Fotocopia','egreso', 'Gastos para la escuela',true),
  ('Gastos Escuela - Combustible/Calef.','egreso', 'Gastos para la escuela',true),
  ('Gastos Escuela - Mobiliario',        'egreso', 'Gastos para la escuela',true),
  ('Gastos Escuela - Alimentos',         'egreso', 'Gastos para la escuela',true),
  ('Gastos Entidad - Org. Rifas',        'egreso', 'Gastos de la entidad',  true),
  ('Gastos Entidad - Org. Festivales',   'egreso', 'Gastos de la entidad',  true),
  ('Gastos Entidad - Impuestos Bancarios','egreso','Gastos de la entidad',  true),
  ('Gastos Entidad - Seguro',            'egreso', 'Gastos de la entidad',  true),
  ('Gastos Entidad - Kiosco (costo)',    'egreso', 'Gastos de la entidad',  true),
  ('Gastos Entidad - Otros',             'egreso', 'Gastos de la entidad',  true);
```

---

## 4. Supabase Storage

En el dashboard de Supabase, crear un bucket llamado `comprobantes`:
- Tipo: **privado** (solo accesible mediante URLs firmadas o service role)
- Políticas: staff puede subir/leer; el bucket no es público.

Crear también bucket `recibos-pdf`:
- Tipo: **privado**
- Mismo criterio de acceso.

---

## 5. Estructura de archivos Next.js

Crear exactamente esta estructura:

```
app/
├── (auth)/
│   └── login/
│       └── page.tsx           # Email + password. Redirige a /dashboard si ya está logueado.
├── (app)/
│   ├── layout.tsx             # Sidebar + Topbar. Protege rutas: redirige a /login si no hay sesión.
│   ├── dashboard/
│   │   └── page.tsx
│   ├── cobros/
│   │   ├── page.tsx           # Selector de sala → alumno
│   │   └── [socio_id]/
│   │       └── page.tsx       # Estado de cuenta + formulario de cobro
│   ├── movimientos/
│   │   └── page.tsx
│   ├── socios/
│   │   └── page.tsx           # Libro de socios + tabla de morosidad
│   ├── eventos/
│   │   ├── page.tsx
│   │   └── [evento_id]/
│   │       └── page.tsx
│   ├── balance/
│   │   ├── [mes]/
│   │   │   └── page.tsx       # mes = "2026-06"
│   │   └── anual/
│   │       └── page.tsx
│   ├── familiar/
│   │   └── page.tsx           # Solo accesible con rol "familiar"
│   └── admin/
│       ├── ciclo/
│       │   └── page.tsx       # Wizard inicio de ciclo
│       ├── categorias/
│       │   └── page.tsx
│       ├── usuarios/
│       │   └── page.tsx
│       └── auditoria/
│           └── page.tsx
├── api/
│   ├── webhooks/
│   │   └── mercadopago/
│   │       └── route.ts       # POST handler del webhook de MP
│   └── recibos/
│       └── [id]/
│           └── pdf/
│               └── route.ts   # GET → devuelve PDF del recibo
└── layout.tsx                 # Root layout con Providers

lib/
├── supabase/
│   ├── client.ts              # createBrowserClient
│   ├── server.ts              # createServerClient (cookies)
│   └── middleware.ts          # refreshSession en cada request
├── actions/                   # Server Actions de Next.js
│   ├── cobros.ts
│   ├── movimientos.ts
│   ├── socios.ts
│   ├── eventos.ts
│   └── ciclo.ts
├── mercadopago.ts
├── pdf/
│   ├── recibo.tsx             # Componente @react-pdf/renderer para recibo
│   └── balance.tsx            # Componente para PDF de balance
└── whatsapp.ts                # Genera links wa.me con el mensaje pre-armado

components/
├── layout/
│   ├── Sidebar.tsx
│   └── Topbar.tsx
├── cobros/
│   ├── SalaSelector.tsx
│   ├── AlumnoCard.tsx         # Muestra estado de cuenta del alumno seleccionado
│   ├── MesGrid.tsx            # Grilla de meses clickeable (pagado/pendiente/seleccionado)
│   └── ReciboModal.tsx        # Modal post-cobro con preview del recibo + botones
├── movimientos/
│   ├── MovimientoForm.tsx
│   └── MovimientosTable.tsx
├── dashboard/
│   ├── KPICard.tsx
│   ├── BalanceChart.tsx       # Recharts bar chart
│   └── DonaChart.tsx
├── socios/
│   └── MorosidadTable.tsx
├── eventos/
│   ├── EventoCard.tsx
│   └── VentasPorSalaTable.tsx
└── shared/
    ├── WhatsAppButton.tsx     # Botón verde con link wa.me
    └── ExportPDFButton.tsx    # Botón que llama a /api/recibos/[id]/pdf o /api/balance/pdf
```

---

## 6. Cableado interno por módulo

### 6.1 Dashboard

**Datos necesarios** (server component, todo en paralelo con `Promise.all`):
```
- Saldo actual = SUM(monto) FILTER (tipo='ingreso') - SUM(monto) FILTER (tipo='egreso') del ciclo activo
- Ingresos del mes = SUM WHERE tipo='ingreso' AND DATE_TRUNC('month', fecha) = mes actual
- Egresos del mes = idem con egreso
- Socios al día = COUNT socios - COUNT de v_morosidad
- Morosos críticos = SELECT * FROM v_morosidad WHERE meses_sin_pagar >= 2
- Últimos 8 movimientos = ORDER BY created_at DESC LIMIT 8
- Pagos MP del mes = COUNT WHERE fuente='mercadopago' AND mes actual
```

Todo se obtiene con el Supabase client del lado del servidor (Server Component).

---

### 6.2 Cobros — flujo completo

**Página `/cobros`:**
- Carga salas del ciclo activo: `SELECT * FROM salas WHERE ciclo_lectivo_id = activo`
- Al seleccionar sala: `SELECT * FROM socios WHERE sala_id = $1 AND activo = true ORDER BY apellido`
- Al seleccionar alumno: redirige a `/cobros/[socio_id]`

**Página `/cobros/[socio_id]`:**
- Carga el socio y sus pagos: `SELECT * FROM pagos_socios WHERE socio_id = $1 AND ciclo_lectivo_id = $2`
- Carga precios del ciclo: `SELECT * FROM precios_ciclo WHERE ciclo_lectivo_id = $2`
- El componente `MesGrid` recibe: lista de meses del ciclo, lista de conceptos ya pagados, precios. Muestra cada mes como verde (pagado/bloqueado) o clickeable (pendiente).

**Server Action `procesarCobro(formData)`:**
```typescript
// En lib/actions/cobros.ts
// 1. Validar items seleccionados (al menos uno)
// 2. Calcular monto total
// 3. Dentro de una transacción Supabase (o llamadas secuenciales con rollback manual):
//    a. INSERT movimientos → obtener movimiento_id
//    b. INSERT pagos_socios (uno por cada concepto+periodo seleccionado)
//       con UNIQUE constraint, si ya existe → ignorar (ON CONFLICT DO NOTHING)
//    c. INSERT recibos con items en JSONB
// 4. Registrar en auditoria
// 5. Retornar { ok: true, recibo_id, numero_recibo, items, total }
// El componente ReciboModal se abre en el cliente con este resultado.
```

**ReciboModal** en el cliente:
- Muestra preview del recibo (número, alumno, items, total, fecha)
- Botón "Compartir por WhatsApp" → `whatsapp.ts` genera el link:
  ```
  https://wa.me/?text=Recibo+Nº+XXX+%E2%80%94+Cooperadora+JI+923%0A...
  ```
- Botón "Descargar PDF" → llama a `GET /api/recibos/[id]/pdf`

**`/api/recibos/[id]/pdf`:**
- Verifica autenticación y rol
- Carga el recibo de la BD
- Renderiza `<ReciboDocument />` con `@react-pdf/renderer`
- Devuelve el PDF como `application/pdf` (puede guardar en Storage y actualizar `pdf_url`)

---

### 6.3 Movimientos

**Server Action `registrarMovimiento(formData)`:**
```typescript
// 1. Si hay foto: subir a Supabase Storage bucket "comprobantes"
//    → path: `${ciclo_id}/${fecha}/${uuid}.jpg`
//    → obtener URL firmada (1 año de validez) o URL pública si el bucket es público
// 2. INSERT movimientos con todos los campos
// 3. Registrar en auditoria
// 4. Retornar el movimiento creado
```

La tabla de movimientos del lado derecho es un Server Component que se revalida con `revalidatePath('/movimientos')` después de cada insert.

---

### 6.4 Socios y Morosidad

**Página `/socios`:**
- Carga de `v_morosidad` para la lista de morosos
- Carga de socios con su estado de pagos para el libro completo

**Botón "Enviar WA":** no llama a ninguna API, genera un link `wa.me` con texto prearmado:
```
https://wa.me/549XXXXXXXXXX?text=Estimada+familia...
```
El número de teléfono del familiar no está en la BD en esta versión; el link se abre sin número y el usuario copia/pega. **Si el cliente quiere agregar teléfonos, preguntar antes de modificar el schema.**

---

### 6.5 Eventos y Rifas

**CRUD completo:**
- Crear evento → INSERT en `eventos`
- Registrar ventas → INSERT en `ventas_evento` (por sala)
- Ver progreso → JOIN `ventas_evento` GROUP BY sala_id
- Cerrar evento → UPDATE `eventos` SET estado='cerrado'; opcionalmente INSERT en `movimientos` el ingreso total neto

---

### 6.6 Pagos Digitales — MercadoPago

**Flujo de link de pago:**
1. Tesorera selecciona alumno + concepto desde la UI
2. Server Action llama a MP SDK:
   ```typescript
   const preference = await mp.preferences.create({
     items: [{ title: `Cuota Junio — ${alumno.apellido} ${alumno.nombre}`, unit_price: monto, quantity: 1 }],
     external_reference: `${socio_id}|${concepto}|${periodo}`,
     notification_url: `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/mercadopago`,
     back_urls: { success: `${APP_URL}/cobros/${socio_id}?mp=ok` }
   });
   ```
3. Devuelve `preference.sandbox_init_point` (test) o `init_point` (producción) para mostrar QR o link

**Webhook `/api/webhooks/mercadopago` (POST):**
```typescript
// 1. Verificar firma del webhook con MP_WEBHOOK_SECRET
// 2. Si action === "payment" y status === "approved":
//    a. Obtener detalles del pago con mp.payment.get(payment_id)
//    b. Parsear external_reference → { socio_id, concepto, periodo }
//    c. Server-side: INSERT movimientos (fuente='mercadopago', mp_payment_id)
//    d. INSERT pagos_socios ON CONFLICT DO NOTHING
//    e. INSERT recibos
//    f. Registrar en auditoria
// 3. Responder 200 OK siempre (MP reintenta si recibe otro código)
```

---

### 6.7 Balance Mensual

**Página `/balance/[mes]`** (mes = "2026-06"):
```typescript
// Query principal:
const { data } = await supabase
  .from('movimientos')
  .select('monto, tipo, categorias(nombre, grupo)')
  .gte('fecha', `${mes}-01`)
  .lte('fecha', `${mes}-31`)
  .eq('ciclo_lectivo_id', cicloActivo.id);

// Agrupar en JS: entradas por grupo/categoría, salidas por grupo/categoría
// Calcular: total entradas, total salidas, saldo = entradas - salidas
```

**Botón "Exportar Acta":**
- Llama a `GET /api/balance/[mes]/pdf`
- Renderiza un componente `<BalancePDF />` con `@react-pdf/renderer`
- Incluye: encabezado oficial, tabla de entradas, tabla de salidas, saldo, fecha de generación, espacio para firmas

---

### 6.8 Inicio de Ciclo (Wizard)

**Wizard de 4 pasos** — solo accesible con rol `admin`:

1. **Fechas:** nombre del ciclo, fecha_inicio, fecha_fin
2. **Precios:** monto cuota (con distinción mar/abr vs resto), materiales, cuaderno, emergencias
3. **Alumnos:** opción A) importar desde Excel (.xlsx con columnas: apellido, nombre, sala), opción B) copiar socios del ciclo anterior (`INSERT INTO socios SELECT ... FROM socios WHERE ciclo_lectivo_id = anterior`)
4. **Confirmar:** resumen + botón "Iniciar ciclo"

Al confirmar:
```typescript
// Server Action iniciarCiclo(data):
// 1. UPDATE ciclos_lectivos SET activo=false WHERE activo=true
// 2. INSERT ciclos_lectivos (nuevo ciclo) → obtener nuevo_ciclo_id
// 3. INSERT salas (copiar las del ciclo anterior con el nuevo ciclo_id)
// 4. INSERT precios_ciclo con los nuevos montos
// 5. Si opción "copiar alumnos": INSERT socios SELECT ... WHERE ciclo_lectivo_id = anterior_id
// 6. Registrar en auditoria
```

---

### 6.9 Auditoría

`/admin/auditoria` es un Server Component que consulta la tabla `auditoria` con joins a `perfiles` y permite filtrar por usuario/acción/fecha. Solo visible para `admin` y `tesorero`.

Cada Server Action debe llamar a `registrar_auditoria(accion, tabla, id, detalle)` al finalizar.

---

### 6.10 Portal Familiar

**Acceso:**
El familiar recibe un email de invitación desde la UI de usuarios. El admin crea el usuario, lo marca como `rol='familiar'` y asocia su `socio_id`. El familiar hace login con email+password.

**Página `/familiar`:**
- Carga `pagos_socios WHERE socio_id = mi_socio_id()` → muestra grilla de 10 meses
- Carga `recibos WHERE socio_id = mi_socio_id()` → lista de recibos descargables
- Botón "Compartir historial" → genera link `wa.me` con texto de resumen de estado

El familiar **no puede ver datos de otros socios** (garantizado por RLS).

---

## 7. Integración MercadoPago

```typescript
// lib/mercadopago.ts
import MercadoPagoConfig, { Payment, Preference } from 'mercadopago';

export const mp = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN!,
});

export const mpPreference = new Preference(mp);
export const mpPayment    = new Payment(mp);
```

Para el ambiente de pruebas usar `accessToken` de sandbox. Para producción, el real. Documentar en `.env.local` con comentarios cuál es cuál.

---

## 8. Generación de PDF

```typescript
// lib/pdf/recibo.tsx
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

export function ReciboDocument({ recibo, socio }) {
  // Retorna el documento PDF con:
  // - Encabezado: logo + nombre cooperadora + "Recibo Nº XXXXX"
  // - Datos del alumno
  // - Tabla de items con concepto + periodo + monto
  // - Total
  // - Fecha y hora de emisión
  // - "Pago recibido en efectivo" / "Pago recibido vía MercadoPago"
  // - Firma de la tesorera
}
```

---

## 9. Navegación y roles

| Ruta | admin | tesorero | vocal | lector | familiar |
|------|-------|----------|-------|--------|----------|
| /dashboard | ✓ | ✓ | ✓ | ✓ | ✗ |
| /cobros | ✓ | ✓ | ✓ | ✗ | ✗ |
| /movimientos | ✓ | ✓ | ✓ | ✗ | ✗ |
| /socios | ✓ | ✓ | ✓ | ✓ | ✗ |
| /eventos | ✓ | ✓ | ✓ | ✓ | ✗ |
| /balance | ✓ | ✓ | ✓ | ✓ | ✗ |
| /familiar | ✗ | ✗ | ✗ | ✗ | ✓ |
| /admin/* | ✓ | ✗ | ✗ | ✗ | ✗ |
| /admin/auditoria | ✓ | ✓ | ✗ | ✗ | ✗ |

Implementar con middleware de Next.js que lee el rol del servidor y redirige si no tiene acceso.

---

## 10. Middleware de autenticación

```typescript
// middleware.ts (raíz del proyecto)
import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  // 1. Refrescar sesión de Supabase
  // 2. Si no hay sesión y la ruta no es /login → redirigir a /login
  // 3. Si hay sesión y la ruta es /login → redirigir a /dashboard
  // 4. Verificar rol para rutas /admin/* y /familiar
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

---

## 11. Componentes shadcn a usar por módulo

| UI Element | shadcn Component |
|------------|-----------------|
| Tablas | `Table, TableHeader, TableRow, TableCell` |
| Cards de KPI | `Card, CardContent, CardHeader` |
| Formularios | `Select, Input, Label, Button` |
| Modal de recibo | `Dialog, DialogContent, DialogHeader` |
| Notificaciones | `Sonner (toast)` |
| Grilla de meses | CSS Grid custom (ver mock como referencia) |
| Tabs de meses en balance | `Tabs, TabsList, TabsTrigger` |
| Wizard de ciclo | `Progress` + stepper custom |
| Sidebar | `Sheet` (mobile) + div fixed (desktop) |
| Badges de estado | `Badge` con variantes |
| Avatar de usuario | `Avatar, AvatarFallback` |
| Dropdown de usuario | `DropdownMenu` |

---

## 12. Orden de implementación sugerido

Implementar en este orden, en ramas separadas (feat/nombre):

1. `feat/setup` — scaffolding Next.js, Supabase client, middleware, layout con sidebar
2. `feat/auth` — login, logout, perfiles, control de roles por ruta
3. `feat/movimientos` — CRUD de movimientos + upload de foto a Storage
4. `feat/cobros` — selector sala/alumno, MesGrid, procesarCobro, ReciboModal + PDF
5. `feat/dashboard` — KPIs, charts, últimos movimientos, morosos
6. `feat/socios` — libro de socios, v_morosidad, botones WA
7. `feat/balance` — balance mensual, exportar PDF
8. `feat/eventos` — CRUD eventos, ventas por sala
9. `feat/mercadopago` — link de pago, webhook, registro automático
10. `feat/ciclo-wizard` — wizard de inicio de ciclo
11. `feat/auditoria` — tabla de auditoría con filtros
12. `feat/familiar` — portal de solo lectura para familias

**Cada feature se mergea a `develop` con PR. Solo se mergea a `main` cuando está testeado.**

---

## 13. Notas importantes

- **No romper el sistema actual (Google Sheets).** El nuevo sistema corre en paralelo.
- **Los alumnos del mock HTML son reales** — los nombres están en los scripts de Google Apps Script. Usarlos como dato semilla de prueba.
- **Moneda:** todo en pesos argentinos (ARS). No usar librerías de i18n para esto; formatear con `new Intl.NumberFormat('es-AR', {style:'currency', currency:'ARS'})`.
- **Fechas:** usar `date-fns` con locale `es`. El ciclo lectivo va de mayo a abril (no es año calendario).
- **El mock `mock-cooperadora-v2.html`** es la referencia definitiva de diseño. Ante cualquier duda de UI, priorizar lo que muestra ese archivo.
- **Supabase Realtime** no es necesario en la v1. Agregar solo si el cliente lo pide.
- **Testing:** no implementar tests unitarios en la v1 salvo que se pida explícitamente. Sí probar manualmente cada flujo antes de mergear.
