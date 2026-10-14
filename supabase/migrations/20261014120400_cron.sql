-- =============================================================================
-- VK AI Manager — Supabase Cron (pg_cron + pg_net)
--
-- Требования ТЗ §15: идемпотентность, блокировки заданий, повторные попытки,
-- журналирование, защита от дублирования, контроль времени, восстановление после сбоев.
--
-- Все задачи вызывают Edge Function `vk-ai-worker`, которая сама берёт задания из очередей
-- через `claim_*` (FOR UPDATE SKIP LOCKED). Cron не содержит бизнес-логики и не может
-- опубликовать пост: право публикации проверяется в БД и в воркере.
-- =============================================================================

do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron недоступен в этом окружении: %', sqlerrm;
  end;

  begin
    create extension if not exists pg_net;
  exception when others then
    raise notice 'pg_net недоступен в этом окружении: %', sqlerrm;
  end;
end $$;

-- Секреты берутся из Supabase Vault (vault.decrypted_secrets):
--   vk_ai_worker_url      — https://<project-ref>.supabase.co/functions/v1/vk-ai-worker
--   vk_ai_worker_secret   — значение WORKER_SECRET, заданное в секретах функции
-- Если Vault не настроен — задача честно пропускается и пишет запись в журнал.
create or replace function app.vault_secret(p_name text)
returns text
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_value text;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    return null;
  end if;

  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
    into v_value using p_name;

  return v_value;
end;
$$;

create or replace function app.cron_call_worker(p_task text default 'tick')
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_url text := coalesce(app.vault_secret('vk_ai_worker_url'), app.get_setting('worker_url', ''));
  v_secret text := app.vault_secret('vk_ai_worker_secret');
  v_request_id bigint;
begin
  if coalesce(v_url, '') = '' then
    insert into public.audit_logs (action, entity_type, details, result)
    values ('cron_skip', 'worker', jsonb_build_object('task', p_task), 'skipped_no_url');
    return;
  end if;

  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    insert into public.audit_logs (action, entity_type, details, result)
    values ('cron_skip', 'worker', jsonb_build_object('task', p_task), 'skipped_no_pg_net');
    return;
  end if;

  -- Рабочий секрет обязателен: без него воркер отклонит вызов.
  if coalesce(v_secret, '') = '' then
    insert into public.audit_logs (action, entity_type, details, result)
    values ('cron_skip', 'worker', jsonb_build_object('task', p_task), 'skipped_no_secret');
    return;
  end if;

  select net.http_post(
    url := v_url,
    body := jsonb_build_object('task', p_task, 'source', 'pg_cron'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-worker-secret', v_secret
    ),
    timeout_milliseconds := 50000
  ) into v_request_id;

  insert into public.audit_logs (action, entity_type, details, result)
  values ('cron_dispatch', 'worker', jsonb_build_object('task', p_task, 'requestId', v_request_id), 'dispatched');
end;
$$;

-- Обслуживание: восстановление зависших заданий, очистка, снимки аналитики.
create or replace function app.cron_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_requeued jsonb;
  v_notifications int;
  v_jobs int;
  v_snapshots int;
begin
  v_requeued := public.requeue_stale_jobs(600);

  delete from public.notifications where created_at < now() - interval '90 days';
  get diagnostics v_notifications = row_count;

  delete from public.jobs where status in ('done', 'cancelled') and created_at < now() - interval '30 days';
  get diagnostics v_jobs = row_count;

  delete from public.generation_jobs
   where status in ('done', 'cancelled') and created_at < now() - interval '30 days';
  delete from public.publication_jobs
   where status in ('done', 'cancelled', 'skipped') and created_at < now() - interval '60 days';

  -- Суточные снимки аналитики по реальным данным (демо-данные не создаются).
  insert into public.analytics_snapshots (community_id, period_start, period_end, totals, note)
  select s.community_id,
         (current_date - 1),
         (current_date - 1),
         jsonb_build_object(
           'views', sum(s.views), 'likes', sum(s.likes),
           'comments', sum(s.comments), 'shares', sum(s.shares),
           'published', count(distinct s.post_id)
         ),
         'автоматический снимок за сутки'
    from public.post_statistics s
   where s.collected_at::date = current_date - 1
   group by s.community_id;
  get diagnostics v_snapshots = row_count;

  insert into public.audit_logs (action, entity_type, details, result)
  values ('cron_maintenance', 'system',
          jsonb_build_object('requeued', v_requeued, 'notificationsDeleted', v_notifications,
                             'jobsDeleted', v_jobs, 'snapshots', v_snapshots),
          'ok');

  return jsonb_build_object('requeued', v_requeued, 'notificationsDeleted', v_notifications,
                            'jobsDeleted', v_jobs, 'snapshots', v_snapshots);
end;
$$;

revoke all on function app.cron_call_worker(text) from public, anon, authenticated;
revoke all on function app.cron_maintenance() from public, anon, authenticated;
grant execute on function app.cron_call_worker(text) to service_role;
grant execute on function app.cron_maintenance() to service_role;

-- Расписания. Имена фиксированы — повторное применение обновляет задачи, не дублирует их.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron не установлен: расписания не созданы. См. CODEX_SETUP.md.';
    return;
  end if;

  perform cron.schedule('vk-ai-worker-tick', '*/5 * * * *', $cron$ select app.cron_call_worker('tick') $cron$);
  perform cron.schedule('vk-ai-worker-planner', '15 * * * *', $cron$ select app.cron_call_worker('planner') $cron$);
  perform cron.schedule('vk-ai-worker-publication', '*/2 * * * *', $cron$ select app.cron_call_worker('publish_due') $cron$);
  perform cron.schedule('vk-ai-worker-stats', '25 */3 * * *', $cron$ select app.cron_call_worker('stats') $cron$);
  perform cron.schedule('vk-ai-maintenance', '35 0 * * *', $cron$ select app.cron_maintenance() $cron$);
  perform cron.schedule('vk-ai-requeue-stale', '*/20 * * * *', $cron$ select public.requeue_stale_jobs(600) $cron$);
end $$;
