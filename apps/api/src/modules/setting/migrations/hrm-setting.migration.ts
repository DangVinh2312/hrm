import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Editable settings (ADR 0041 §5, ADR 0045). Three tables:
 *  - `setting_anchor`: the singleton record the four `setting.*` permissions apply to (like
 *    `work_calendar`); its `version` column is the one UPDATE column the row lock needs. Created
 *    by the sync login after the release that declares the resource (`ensureSetting`).
 *  - `system_setting`: the current value of a key. No seed: a key without a row means the default
 *    in the code registry. `value` is a JSON scalar (number or string); the registry validates the
 *    kind, range and enum, the CHECKs only keep the shape. No DELETE for the runtime.
 *  - `system_setting_history`: one row per change, with the old and the new value; append-only.
 *    The runtime has SELECT and INSERT only, and a trigger stops UPDATE, DELETE and TRUNCATE for
 *    every login, the table owner included (defense in depth for the audit trail).
 * `updated_by` / `changed_by` reference the account; neither is shown by the API.
 */
export class HrmSetting1792108800113 implements MigrationInterface {
  name = 'HrmSetting1792108800113';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`
      CREATE TABLE setting_anchor(
        id uuid PRIMARY KEY,
        object_id uuid NOT NULL UNIQUE REFERENCES object_ref(object_id),
        singleton boolean NOT NULL DEFAULT true CHECK (singleton),
        version int8 NOT NULL DEFAULT 1 CHECK (version >= 1),
        CONSTRAINT uq_setting_anchor_singleton UNIQUE (singleton)
      );
      CREATE TABLE system_setting(
        key text COLLATE "C" PRIMARY KEY CONSTRAINT ck_system_setting_key CHECK (
          char_length(key) BETWEEN 3 AND 64 AND key ~ '^[a-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*)+$'),
        value jsonb NOT NULL CONSTRAINT ck_system_setting_value CHECK (
          jsonb_typeof(value) IN ('number','string')),
        version int8 NOT NULL CONSTRAINT ck_system_setting_version CHECK (version >= 1),
        updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        updated_by uuid NOT NULL REFERENCES app_user(id)
      );
      CREATE TABLE system_setting_history(
        key text COLLATE "C" NOT NULL REFERENCES system_setting(key),
        version int8 NOT NULL CONSTRAINT ck_system_setting_history_version CHECK (version >= 1),
        old_value jsonb NOT NULL CONSTRAINT ck_system_setting_history_old CHECK (
          jsonb_typeof(old_value) IN ('number','string')),
        new_value jsonb NOT NULL CONSTRAINT ck_system_setting_history_new CHECK (
          jsonb_typeof(new_value) IN ('number','string')),
        changed_by uuid NOT NULL REFERENCES app_user(id),
        changed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        PRIMARY KEY (key, version)
      );
      CREATE FUNCTION public.forbid_setting_history_change() RETURNS trigger
        LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$
      BEGIN
        RAISE EXCEPTION 'system_setting_history is append-only' USING ERRCODE = '42501';
      END $fn$;
      REVOKE ALL ON FUNCTION public.forbid_setting_history_change() FROM PUBLIC;
      CREATE TRIGGER forbid_setting_history_row_change
        BEFORE UPDATE OR DELETE ON system_setting_history
        FOR EACH ROW EXECUTE FUNCTION public.forbid_setting_history_change();
      CREATE TRIGGER forbid_setting_history_truncate
        BEFORE TRUNCATE ON system_setting_history
        FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_setting_history_change();
      GRANT SELECT ON setting_anchor, system_setting, system_setting_history TO product_data;
      GRANT UPDATE(version) ON setting_anchor TO product_data;
      GRANT INSERT ON system_setting, system_setting_history TO product_data;
      GRANT UPDATE(value, version, updated_at, updated_by) ON system_setting TO product_data;
      GRANT SELECT, INSERT ON setting_anchor TO product_sync;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}
