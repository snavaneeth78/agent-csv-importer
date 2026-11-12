-- csv_import schema (tech spec §7). pg-boss manages its own `pgboss` schema.
CREATE SCHEMA IF NOT EXISTS csv_import;

-- Role the library switches to inside withTenant() so RLS applies even when connected as an owner/superuser.
DO $$ BEGIN
  CREATE ROLE csv_import_app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT csv_import_app TO CURRENT_USER;
GRANT USAGE ON SCHEMA csv_import TO csv_import_app;

CREATE TABLE csv_import.imports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  created_by     text NOT NULL,
  thread_id      text,
  source         jsonb NOT NULL,           -- filename, size, sha256, url
  target_id      text NOT NULL,
  target_version int NOT NULL,
  status         text NOT NULL,
  plan           jsonb,
  plan_version   int NOT NULL DEFAULT 0,
  stats          jsonb NOT NULL DEFAULT '{}',
  error          jsonb,
  refs           jsonb,                    -- allowed ref values, fetched once per import
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX imports_tenant_status ON csv_import.imports (tenant_id, status);
CREATE UNIQUE INDEX imports_open_sha ON csv_import.imports (tenant_id, target_id, (source->>'sha256'))
  WHERE status NOT IN ('completed', 'partially_completed', 'failed', 'cancelled') AND source->>'sha256' IS NOT NULL;

CREATE TABLE csv_import.import_rows (
  import_id  uuid NOT NULL REFERENCES csv_import.imports(id) ON DELETE CASCADE,
  row_index  int NOT NULL,
  tenant_id  text NOT NULL,
  raw        jsonb NOT NULL,
  output     jsonb,
  overrides  jsonb,
  issues     jsonb NOT NULL DEFAULT '[]',
  sku        text,
  distru_id  text,
  dup_class  text,
  action     text,
  status     text NOT NULL DEFAULT 'pending',
  followup   boolean NOT NULL DEFAULT false,
  meta       jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (import_id, row_index)
);
CREATE INDEX import_rows_status ON csv_import.import_rows (import_id, status);
CREATE INDEX import_rows_history ON csv_import.import_rows (tenant_id, sku) WHERE status = 'committed';

CREATE TABLE csv_import.import_events (
  id         bigserial PRIMARY KEY,
  import_id  uuid NOT NULL REFERENCES csv_import.imports(id) ON DELETE CASCADE,
  tenant_id  text NOT NULL,
  type       text NOT NULL,
  actor      text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_events_import ON csv_import.import_events (import_id, id);

CREATE TABLE csv_import.import_chunks (
  import_id    uuid NOT NULL REFERENCES csv_import.imports(id) ON DELETE CASCADE,
  stage        text NOT NULL,
  chunk_index  int NOT NULL,
  tenant_id    text NOT NULL,
  plan_version int NOT NULL,
  status       text NOT NULL,
  attempts     int NOT NULL DEFAULT 0,
  response     jsonb,
  PRIMARY KEY (import_id, stage, chunk_index)
);

-- Transient staging for { bytes } / { stream } inputs between start() and csv.parse. Deleted at Gate 2 or cancel.
CREATE TABLE csv_import.import_files (
  import_id uuid PRIMARY KEY REFERENCES csv_import.imports(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  bytes     bytea NOT NULL
);

CREATE TABLE csv_import.catalog_snapshot_state (
  tenant_id    text PRIMARY KEY,
  status       text NOT NULL,
  cursor       text,
  refreshed_at timestamptz
);

CREATE TABLE csv_import.catalog_snapshot (
  tenant_id         text NOT NULL,
  distru_id         text NOT NULL,
  sku               text,
  upc               text,
  name              text NOT NULL,
  name_norm         text NOT NULL,
  values            jsonb NOT NULL,
  distru_updated_at timestamptz,
  PRIMARY KEY (tenant_id, distru_id)
);
CREATE INDEX catalog_snapshot_sku ON csv_import.catalog_snapshot (tenant_id, upper(sku));
CREATE INDEX catalog_snapshot_upc ON csv_import.catalog_snapshot (tenant_id, upc);
CREATE INDEX catalog_snapshot_name ON csv_import.catalog_snapshot (tenant_id, name_norm);

CREATE TABLE csv_import.column_memory (
  tenant_id    text NOT NULL,
  target_id    text NOT NULL,
  header_norm  text NOT NULL,
  target_field text NOT NULL,
  transforms   jsonb NOT NULL,
  type_sig     text NOT NULL,
  hits         int NOT NULL DEFAULT 1,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, target_id, header_norm)
);

-- Row-level security: defense in depth on top of tenant-scoped queries. withTenant() runs as csv_import_app
-- (RLS applies); system jobs run as the owner role and read ids only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['imports','import_rows','import_events','import_chunks','import_files','catalog_snapshot_state','catalog_snapshot','column_memory'] LOOP
    EXECUTE format('ALTER TABLE csv_import.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON csv_import.%I USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON csv_import.%I TO csv_import_app', t);
  END LOOP;
END $$;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA csv_import TO csv_import_app;
