-- +goose Up
-- +goose StatementBegin

      GRANT SELECT ON public.role_anchor TO product_authority;
      GRANT UPDATE (singleton) ON public.role_anchor TO product_authority;
    
-- +goose StatementEnd
