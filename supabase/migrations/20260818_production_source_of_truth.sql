-- Make the production Claude UI read and write the canonical EZWin tables.
alter table public.lottery_entries add column if not exists has_r boolean not null default false;
alter table public.lottery_weeks add column if not exists draft_result text check (draft_result is null or draft_result ~ '^[0-9]{3}$');

-- Public community cards are derived from profiles without exposing full IDs.
create or replace function public.get_community_profiles()
returns table(
  profile_id uuid,
  nickname text,
  masked_id text,
  avatar_key text,
  joined_at timestamptz,
  active_entry_count bigint,
  win_count bigint
)
language sql
stable
security definer
set search_path=public
as $$
  select
    p.id,
    p.nickname,
    public.mask_generated_name(p.generated_name),
    p.avatar_key,
    p.created_at,
    (select count(*) from public.lottery_entries e where e.user_id=p.id),
    (select count(*) from public.community_activity a where a.actor_user_id=p.id and a.activity_type in ('exact_won','twd_won'))
  from public.profiles p
  where p.is_active
  order by p.created_at desc;
$$;
grant execute on function public.get_community_profiles() to anon, authenticated;

create or replace function public.get_current_number_board()
returns table(number text, is_closed boolean, entry_count bigint, has_r boolean)
language sql stable security definer set search_path=public as $$
  with current_week as (
    select id from public.lottery_weeks where is_current order by created_at desc limit 1
  ), numbers as (
    select e.number, count(*)::bigint as entry_count, bool_or(e.has_r) as has_r
    from public.lottery_entries e join current_week w on w.id=e.week_id
    group by e.number
  ), closed as (
    select c.number from public.closed_numbers c join current_week w on w.id=c.week_id
  )
  select coalesce(n.number,c.number), c.number is not null, coalesce(n.entry_count,0), coalesce(n.has_r,false)
  from numbers n full join closed c on c.number=n.number;
$$;
grant execute on function public.get_current_number_board() to anon, authenticated;

drop policy if exists "public read weeks" on public.lottery_weeks;
create policy "public read weeks" on public.lottery_weeks for select to anon using(true);
drop policy if exists "public read results" on public.lottery_results;
create policy "public read results" on public.lottery_results for select to anon using(true);
drop policy if exists "public read active dream100" on public.dream100_items;
create policy "public read active dream100" on public.dream100_items for select to anon using(is_active);

-- Keep the optional normalized role table synchronized with profiles.role.
create or replace function public.sync_user_role_from_profile() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  insert into public.user_roles(user_id,role,assigned_by,assigned_at)
  values(new.id,new.role,new.created_by,now())
  on conflict(user_id) do update set role=excluded.role,assigned_by=excluded.assigned_by,assigned_at=now();
  return new;
end $$;
drop trigger if exists ezwin_sync_user_role on public.profiles;
create trigger ezwin_sync_user_role after insert or update of role on public.profiles
for each row execute function public.sync_user_role_from_profile();
insert into public.user_roles(user_id,role,assigned_by)
select id,role,created_by from public.profiles
on conflict(user_id) do update set role=excluded.role,assigned_by=excluded.assigned_by,assigned_at=now();

create or replace function public.save_batch_atomic(p_batch_id uuid,p_week_id uuid,p_user_id uuid,p_entries jsonb,p_actor_id uuid)
returns public.lottery_batches language plpgsql security definer set search_path=public as $$
declare b public.lottery_batches; seq integer; item jsonb; number_value text; amount_value numeric; closed boolean; reverse_value boolean;
begin
 if not exists(
   select 1 from profiles
   where id=p_actor_id and is_active and (role in ('admin','staff') or id=p_user_id)
 ) then raise exception 'Forbidden'; end if;
 if not exists(select 1 from profiles where id=p_user_id and role='user' and is_active)
    or not exists(select 1 from lottery_weeks where id=p_week_id and is_open)
 then raise exception 'Invalid target'; end if;
 if jsonb_typeof(p_entries)<>'array' or jsonb_array_length(p_entries)=0 or jsonb_array_length(p_entries)>500 then raise exception 'Invalid entries'; end if;
 perform pg_advisory_xact_lock(hashtext(p_week_id::text));
 if p_batch_id is null then
   select coalesce(max(sequence_no),0)+1 into seq from member_week_sequences where week_id=p_week_id;
   insert into member_week_sequences(week_id,user_id,sequence_no) values(p_week_id,p_user_id,seq)
   on conflict(week_id,user_id) do update set user_id=excluded.user_id returning sequence_no into seq;
   insert into lottery_batches(week_id,user_id,sequence_no,status,created_by)
   values(p_week_id,p_user_id,seq,'draft',p_actor_id) returning * into b;
 else
   select * into b from lottery_batches where id=p_batch_id for update;
   if b.id is null or b.week_id<>p_week_id or b.user_id<>p_user_id or b.status not in ('draft','pending') then raise exception 'Batch cannot be edited'; end if;
   delete from lottery_entries where batch_id=b.id;
 end if;
 for item in select * from jsonb_array_elements(p_entries) loop
   number_value:=item->>'number'; amount_value:=(item->>'amount')::numeric; reverse_value:=coalesce((item->>'has_r')::boolean,false);
   if number_value !~ '^[0-9]{3}$' or amount_value<=0 then raise exception 'Invalid entry'; end if;
   select exists(select 1 from closed_numbers where week_id=p_week_id and number=number_value) into closed;
   if closed then raise exception '% သည် ပိတ်ဂဏန်းဖြစ်ပါသည်။',number_value; end if;
   insert into lottery_entries(batch_id,week_id,user_id,number,amount,is_closed,has_r)
   values(b.id,p_week_id,p_user_id,number_value,amount_value,false,reverse_value);
 end loop;
 update lottery_batches set total_amount=(select sum(amount) from lottery_entries where batch_id=b.id),status='pending',submitted_at=coalesce(submitted_at,now()),submitted_by=coalesce(submitted_by,p_actor_id) where id=b.id returning * into b;
 insert into audit_logs(actor_id,action,entity_type,entity_id,metadata)
 values(p_actor_id,case when p_batch_id is null then 'BATCH_CREATED' else 'BATCH_EDITED' end,'lottery_batch',b.id::text,jsonb_build_object('entry_count',jsonb_array_length(p_entries),'user_id',p_user_id));
 return b;
end $$;
revoke execute on function public.save_batch_atomic(uuid,uuid,uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.save_batch_atomic(uuid,uuid,uuid,jsonb,uuid) to service_role;

create or replace function public.save_result_draft_atomic(p_week_id uuid,p_result text,p_actor_id uuid)
returns public.lottery_weeks language plpgsql security definer set search_path=public as $$
declare w public.lottery_weeks;
begin
 if not exists(select 1 from profiles where id=p_actor_id and role='admin' and is_active) then raise exception 'Forbidden'; end if;
 if p_result !~ '^[0-9]{3}$' then raise exception 'Invalid result'; end if;
 update lottery_weeks set draft_result=p_result where id=p_week_id returning * into w;
 if w.id is null then raise exception 'Week not found'; end if;
 insert into audit_logs(actor_id,action,entity_type,entity_id,metadata) values(p_actor_id,'RESULT_DRAFT_SAVED','lottery_week',p_week_id::text,jsonb_build_object('result_number',p_result));
 return w;
end $$;
revoke execute on function public.save_result_draft_atomic(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.save_result_draft_atomic(uuid,text,uuid) to service_role;

-- Publishing clears the draft and remains the only path that creates a visible result.
create or replace function public.publish_result_atomic(p_week_id uuid,p_result text,p_actor_id uuid)
returns public.lottery_results language plpgsql security definer set search_path=public as $$
declare r public.lottery_results;
begin
 if not exists(select 1 from profiles where id=p_actor_id and role='admin' and is_active) then raise exception 'Forbidden'; end if;
 if p_result !~ '^[0-9]{3}$' then raise exception 'Invalid result'; end if;
 insert into lottery_results(week_id,result_number,published_by) values(p_week_id,p_result,p_actor_id)
 on conflict(week_id) do update set result_number=excluded.result_number,published_by=excluded.published_by,published_at=now() returning * into r;
 update lottery_weeks set is_open=false,draft_result=null where id=p_week_id;
 insert into audit_logs(actor_id,action,entity_type,entity_id,metadata) values(p_actor_id,'RESULT_PUBLISHED','lottery_week',p_week_id::text,jsonb_build_object('result_number',p_result));
 return r;
end $$;
