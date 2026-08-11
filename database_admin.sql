-- ============================================================
-- GESTOR FINANCEIRO PRO — database_admin.sql
-- Tabelas do painel do Administrador
-- Execute no SQL Editor do Supabase após o database.sql inicial
-- ============================================================


-- ── 1. Clientes ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.clientes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id   UUID NOT NULL REFERENCES public.perfis(id) ON DELETE CASCADE,
  nome       TEXT NOT NULL,
  email      TEXT,
  cpf        TEXT,
  telefone   TEXT,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clientes: admin vê seus clientes"
  ON public.clientes FOR ALL
  USING (auth.uid() = admin_id);


-- ── 2. Transações ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.transacoes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id   UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  data         DATE NOT NULL,
  valor        NUMERIC(12,2) NOT NULL,
  descricao    TEXT,
  categoria    TEXT,
  tipo         TEXT NOT NULL CHECK (tipo IN ('receita', 'despesa')),
  import_hash  TEXT UNIQUE,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.transacoes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Transações: admin vê via clientes"
  ON public.transacoes FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.clientes c
      WHERE c.id = transacoes.cliente_id
        AND c.admin_id = auth.uid()
    )
  );


-- ── 3. Metas ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.metas (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id         UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  titulo             TEXT NOT NULL,
  valor_necessario   NUMERIC(12,2) NOT NULL DEFAULT 0,
  valor_economizado  NUMERIC(12,2) NOT NULL DEFAULT 0,
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.metas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Metas: admin vê via clientes"
  ON public.metas FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.clientes c
      WHERE c.id = metas.cliente_id
        AND c.admin_id = auth.uid()
    )
  );


-- ── 4. Planejamentos ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.planejamentos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id        UUID NOT NULL REFERENCES public.perfis(id) ON DELETE CASCADE,
  cliente_id      UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  titulo          TEXT NOT NULL,
  recomendacoes   TEXT,
  detalhes        TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.planejamentos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Planejamentos: admin vê os seus"
  ON public.planejamentos FOR ALL
  USING (auth.uid() = admin_id);


-- ── 5. Comentários de Clientes ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.comentarios_clientes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id  UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  admin_id    UUID NOT NULL REFERENCES public.perfis(id) ON DELETE CASCADE,
  texto       TEXT NOT NULL,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.comentarios_clientes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Comentários: admin vê os seus"
  ON public.comentarios_clientes FOR ALL
  USING (auth.uid() = admin_id);


-- ── Verificação ───────────────────────────────────────────────
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
-- ORDER BY table_name;
