-- +goose Up
-- +goose StatementBegin

      ALTER TABLE public.role_definition ADD CONSTRAINT ck_role_runtime_prefix
        CHECK ((managed_by = 'runtime') = (substring(role_key FROM 1 FOR 7) = convert_to('custom.', 'UTF8')));
      CREATE FUNCTION public.protect_role_rules() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$
      BEGIN
        IF current_user='product_authority' AND (NEW.effect<>'allow'
          OR NEW.role_key IS NULL OR NEW.managed_by<>'runtime'
          OR substring(NEW.role_key FROM 1 FOR 7)<>convert_to('custom.','UTF8')) THEN
          RAISE EXCEPTION 'authority may only write allow rules of runtime roles' USING ERRCODE='42501';
        END IF;
        RETURN NEW;
      END $fn$;
      REVOKE ALL ON FUNCTION public.protect_role_rules() FROM PUBLIC;
      CREATE TRIGGER protect_role_rules BEFORE INSERT OR UPDATE ON public.policy_rule
        FOR EACH ROW EXECUTE FUNCTION public.protect_role_rules();
    
-- +goose StatementEnd
