-- Service-role PostgREST writes invoke hash triggers as service_role.
-- Nested canonical hash helpers need explicit EXECUTE after the blanket revoke.
grant usage on schema app to service_role;
grant execute on function app.content_hash(text,text,text,timestamptz) to service_role;
grant execute on function app.normalize_text(text) to service_role;
