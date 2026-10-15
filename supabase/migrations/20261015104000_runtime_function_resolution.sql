set check_function_bodies = off;

-- Qualify pgcrypto in historical function bodies, without rewriting migrations.
do $$
declare r record; definition text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('app','public') and p.prokind='f'
      and p.proname not in ('digest','gen_random_bytes')
  loop
    definition := pg_get_functiondef(r.oid);
    if definition like '%CREATE OR REPLACE FUNCTION public.enqueue_upcoming_generations(%' then
      definition := replace(definition, '  r record;', E'  r record;\n  r2 record;');
    end if;
    if definition ~ '\m(digest|gen_random_bytes)\(' then
      definition := regexp_replace(definition, '([^[:alnum:]_.])(digest|gen_random_bytes)\(', '\1extensions.\2(', 'g');
      execute definition;
    end if;
  end loop;
end $$;
drop function public.digest(text,text);
drop function public.gen_random_bytes(integer);
-- missed_slots previously attempted timestamp + text in its SELECT expression.
do $$
declare definition text;
begin
  definition := pg_get_functiondef('public.missed_slots(integer)'::regprocedure);
  definition := replace(definition, 'd.day + s.slot_time', 'd.day + (s.slot_time)::time');
  definition := replace(definition, 'd.day +', 'd.day::date +');
  execute definition;
end $$;

set check_function_bodies = on;
