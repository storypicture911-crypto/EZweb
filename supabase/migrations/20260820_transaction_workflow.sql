-- Treat lottery_batches as the canonical transaction parent and lottery_entries as its lines.
drop index if exists public.lottery_batches_active_user_week_idx;
create unique index if not exists lottery_batches_week_serial_uidx
  on public.lottery_batches(week_id, sequence_no)
  where status <> 'cancelled';

create or replace function public.lottery_line_total(p_number text, p_amount numeric, p_has_r boolean)
returns numeric language sql immutable set search_path='' as $$
  select p_amount * case
    when not p_has_r then 1
    when substr(p_number,1,1)=substr(p_number,2,1) and substr(p_number,2,1)=substr(p_number,3,1) then 1
    when substr(p_number,1,1)=substr(p_number,2,1)
      or substr(p_number,1,1)=substr(p_number,3,1)
      or substr(p_number,2,1)=substr(p_number,3,1) then 3
    else 6
  end;
$$;

drop function if exists public.save_batch_atomic(uuid,uuid,uuid,jsonb,uuid);
create or replace function public.save_batch_atomic(
  p_batch_id uuid,
  p_week_id uuid,
  p_user_id uuid,
  p_serial_number integer,
  p_entries jsonb,
  p_actor_id uuid
)
returns public.lottery_batches language plpgsql security definer set search_path=public as $$
declare
  b public.lottery_batches;
  actor_role public.app_role;
  serial_value integer;
  item jsonb;
  number_value text;
  amount_value numeric;
  closed boolean;
  reverse_value boolean;
begin
  select role into actor_role from profiles where id=p_actor_id and is_active;
  if actor_role is null or (actor_role='user' and p_actor_id<>p_user_id) then raise exception 'Forbidden'; end if;
  if not exists(select 1 from profiles where id=p_user_id and role='user' and is_active)
     or not exists(select 1 from lottery_weeks where id=p_week_id and is_open)
  then raise exception 'INVALID_TARGET'; end if;
  if jsonb_typeof(p_entries)<>'array' or jsonb_array_length(p_entries)=0 or jsonb_array_length(p_entries)>500
  then raise exception 'INVALID_ENTRIES'; end if;

  perform pg_advisory_xact_lock(hashtext(p_week_id::text));
  if p_batch_id is null then
    if actor_role in ('admin','staff') then
      if p_serial_number is null or p_serial_number < 1 or p_serial_number > 999999 then raise exception 'INVALID_SERIAL'; end if;
      serial_value := p_serial_number;
    else
      select coalesce(max(sequence_no),0)+1 into serial_value
      from lottery_batches where week_id=p_week_id and status<>'cancelled';
    end if;
    if exists(select 1 from lottery_batches where week_id=p_week_id and sequence_no=serial_value and status<>'cancelled')
    then raise exception 'DUPLICATE_SERIAL:%', serial_value; end if;
    insert into lottery_batches(week_id,user_id,sequence_no,status,created_by,submitted_at,submitted_by)
    values(p_week_id,p_user_id,serial_value,'pending',p_actor_id,now(),p_actor_id)
    returning * into b;
  else
    select * into b from lottery_batches where id=p_batch_id for update;
    if b.id is null or b.week_id<>p_week_id or b.user_id<>p_user_id or b.status not in ('draft','pending')
    then raise exception 'BATCH_NOT_EDITABLE'; end if;
    if actor_role='user' and b.created_by<>p_actor_id then raise exception 'Forbidden'; end if;
    serial_value := case when actor_role in ('admin','staff') then p_serial_number else b.sequence_no end;
    if serial_value is null or serial_value < 1 or serial_value > 999999 then raise exception 'INVALID_SERIAL'; end if;
    if exists(select 1 from lottery_batches where week_id=p_week_id and sequence_no=serial_value and id<>b.id and status<>'cancelled')
    then raise exception 'DUPLICATE_SERIAL:%', serial_value; end if;
    update lottery_batches set sequence_no=serial_value where id=b.id returning * into b;
    delete from lottery_entries where batch_id=b.id;
  end if;

  for item in select * from jsonb_array_elements(p_entries) loop
    number_value:=item->>'number'; amount_value:=(item->>'amount')::numeric;
    reverse_value:=coalesce((item->>'has_r')::boolean,false);
    if number_value !~ '^[0-9]{3}$' or amount_value<=0 then raise exception 'INVALID_ENTRY'; end if;
    select exists(select 1 from closed_numbers where week_id=p_week_id and number=number_value) into closed;
    if closed then raise exception '% သည် ပိတ်ဂဏန်းဖြစ်ပါသည်။',number_value; end if;
    insert into lottery_entries(batch_id,week_id,user_id,number,amount,is_closed,has_r)
    values(b.id,p_week_id,p_user_id,number_value,amount_value,false,reverse_value);
  end loop;

  update lottery_batches
  set total_amount=(select coalesce(sum(public.lottery_line_total(number,amount,has_r)),0) from lottery_entries where batch_id=b.id),
      status='pending', submitted_at=coalesce(submitted_at,now()), submitted_by=coalesce(submitted_by,p_actor_id)
  where id=b.id returning * into b;
  insert into audit_logs(actor_id,action,entity_type,entity_id,metadata)
  values(p_actor_id,case when p_batch_id is null then 'TRANSACTION_CREATED' else 'TRANSACTION_EDITED' end,
    'lottery_transaction',b.id::text,jsonb_build_object('serial_number',b.sequence_no,'entry_count',jsonb_array_length(p_entries),'user_id',p_user_id));
  return b;
exception when unique_violation then
  raise exception 'DUPLICATE_SERIAL:%', coalesce(serial_value,p_serial_number);
end $$;
revoke execute on function public.save_batch_atomic(uuid,uuid,uuid,integer,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.save_batch_atomic(uuid,uuid,uuid,integer,jsonb,uuid) to service_role;

create or replace function public.approve_batch_atomic(p_batch_id uuid,p_actor_id uuid)
returns public.lottery_batches language plpgsql security definer set search_path=public as $$
declare b public.lottery_batches; p public.profiles; total numeric;
begin
  if not exists(select 1 from profiles where id=p_actor_id and role='admin' and is_active) then raise exception 'Forbidden'; end if;
  select * into b from lottery_batches where id=p_batch_id for update;
  if b.id is null or b.status not in ('pending','sent_to_dealer') then raise exception 'TRANSACTION_NOT_CONFIRMABLE'; end if;
  select coalesce(sum(public.lottery_line_total(number,amount,has_r)),0) into total from lottery_entries where batch_id=p_batch_id and not is_closed;
  if total<=0 then raise exception 'TRANSACTION_EMPTY'; end if;
  update lottery_batches set status='approved',total_amount=total,approved_at=now(),approved_by=p_actor_id where id=p_batch_id returning * into b;
  select * into p from profiles where id=b.user_id;
  insert into community_activity(actor_user_id,nickname_snapshot,masked_id_snapshot,avatar_key_snapshot,activity_type,safe_payload)
  values(p.id,p.nickname,mask_generated_name(p.generated_name),p.avatar_key,'batch_approved',jsonb_build_object('week_id',b.week_id,'serial_number',b.sequence_no,'message_type','transaction_confirmed'));
  insert into audit_logs(actor_id,action,entity_type,entity_id,metadata)
  values(p_actor_id,'TRANSACTION_CONFIRMED','lottery_transaction',b.id::text,jsonb_build_object('serial_number',b.sequence_no,'total_amount',total,'user_id',b.user_id));
  return b;
end $$;

create or replace function public.delete_lottery_transaction_atomic(p_batch_id uuid,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare b public.lottery_batches; line_count integer;
begin
  if not exists(select 1 from profiles where id=p_actor_id and role='admin' and is_active) then raise exception 'Forbidden'; end if;
  select * into b from lottery_batches where id=p_batch_id for update;
  if b.id is null then raise exception 'TRANSACTION_NOT_FOUND'; end if;
  select count(*) into line_count from lottery_entries where batch_id=b.id;
  delete from lottery_batches where id=b.id;
  insert into audit_logs(actor_id,action,entity_type,entity_id,metadata)
  values(p_actor_id,'TRANSACTION_DELETED','lottery_transaction',b.id::text,
    jsonb_build_object('serial_number',b.sequence_no,'user_id',b.user_id,'week_id',b.week_id,'line_count',line_count));
  return jsonb_build_object('id',b.id,'serial_number',b.sequence_no,'deleted_lines',line_count);
end $$;
revoke execute on function public.delete_lottery_transaction_atomic(uuid,uuid) from public,anon,authenticated;
grant execute on function public.delete_lottery_transaction_atomic(uuid,uuid) to service_role;

-- Public/owner reads come through this safe projection. Pending records are visible only to their owner.
create or replace function public.get_visible_lottery_entries()
returns table(
  id uuid,batch_id uuid,week_id uuid,user_id uuid,number text,amount numeric,is_closed boolean,has_r boolean,
  created_at timestamptz,sequence_no integer,status public.entry_status,confirmed_at timestamptz,
  nickname text,display_id text,avatar_key text,week_title text,draw_date timestamptz,is_current boolean,is_open boolean,via_admin boolean
)
language sql stable security definer set search_path=public as $$
  select e.id,e.batch_id,e.week_id,e.user_id,e.number,e.amount,e.is_closed,e.has_r,e.created_at,
    b.sequence_no,b.status,b.approved_at,p.nickname,
    case when p.id=auth.uid() then p.generated_name else public.mask_generated_name(p.generated_name) end,
    p.avatar_key,w.title,w.draw_date,w.is_current,w.is_open,(b.created_by<>b.user_id)
  from lottery_entries e
  join lottery_batches b on b.id=e.batch_id
  join profiles p on p.id=e.user_id
  join lottery_weeks w on w.id=e.week_id
  where b.status='approved' or e.user_id=auth.uid()
  order by b.created_at desc,e.created_at;
$$;
grant execute on function public.get_visible_lottery_entries() to anon,authenticated;

create or replace function public.get_community_profiles()
returns table(profile_id uuid,nickname text,masked_id text,avatar_key text,joined_at timestamptz,active_entry_count bigint,win_count bigint)
language sql stable security definer set search_path=public as $$
  select p.id,p.nickname,public.mask_generated_name(p.generated_name),p.avatar_key,p.created_at,
    (select count(*) from lottery_entries e join lottery_batches b on b.id=e.batch_id where e.user_id=p.id and b.status='approved'),
    (select count(*) from community_activity a where a.actor_user_id=p.id and a.activity_type in ('exact_won','twd_won'))
  from profiles p where p.is_active order by p.created_at desc;
$$;

drop policy if exists "users read own batches" on public.lottery_batches;
create policy "users read own staff or confirmed batches" on public.lottery_batches for select to authenticated
using(user_id=(select auth.uid()) or public.is_staff_or_admin() or status='approved');
drop policy if exists "users read own entries" on public.lottery_entries;
create policy "users read own staff or confirmed entries" on public.lottery_entries for select to authenticated
using(user_id=(select auth.uid()) or public.is_staff_or_admin() or exists(select 1 from public.lottery_batches b where b.id=batch_id and b.status='approved'));
