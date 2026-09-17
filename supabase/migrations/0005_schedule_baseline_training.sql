-- Portable equivalent of deployed migration 20260917063216_schedule_baseline_training.

create or replace function public.invoke_baseline_training()
returns bigint
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.invoke_edge_function('train-baseline');
$$;
revoke all on function public.invoke_baseline_training() from public;
grant execute on function public.invoke_baseline_training() to service_role, postgres;

do $$
begin
  if exists (select 1 from pg_extension where extname='pg_cron') then
    if not exists (select 1 from cron.job where jobname='gold-baseline-train') then
      perform cron.schedule('gold-baseline-train','17 1 * * *','select public.invoke_baseline_training();');
    end if;
  end if;
end $$;
