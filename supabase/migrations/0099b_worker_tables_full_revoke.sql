revoke truncate, references, trigger on public.crew_workers from anon, authenticated;
revoke truncate, references, trigger on public.job_workers  from anon, authenticated;

do $$
declare leftover text;
begin
  select string_agg(grantee||':'||privilege_type, ' ')
    into leftover
    from information_schema.role_table_grants
   where table_schema='public'
     and table_name in ('crew_workers','job_workers')
     and grantee in ('anon','authenticated')
     and privilege_type <> 'SELECT';
  if leftover is not null then
    raise exception '0099b: client roles still hold % on the worker tables', leftover;
  end if;
end $$;
