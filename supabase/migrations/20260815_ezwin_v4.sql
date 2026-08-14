-- EZWin V4 additive migration. It does not drop existing application tables or data.
create extension if not exists pgcrypto;

do $$ begin create type public.app_role as enum ('admin','staff','user'); exception when duplicate_object then null; end $$;
do $$ begin create type public.entry_status as enum ('draft','pending','sent_to_dealer','approved','rejected','cancelled'); exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  generated_name text not null,
  nickname text,
  role public.app_role not null default 'user',
  avatar_key text not null default 'lucky-clover-01',
  is_active boolean not null default true,
  legacy_id text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), nickname_updated_at timestamptz,
  constraint generated_name_format check (generated_name ~ '^@py[A-HJ-NP-Za-hj-np-z2-9]{6}$')
);
create unique index if not exists profiles_generated_name_lower_uidx on public.profiles(lower(generated_name));
create index if not exists profiles_nickname_search_idx on public.profiles(lower(nickname));

-- Server-only mapping; synthetic auth identifiers are never returned to browsers.
create table if not exists public.auth_identities (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  internal_email text not null unique, pin_version integer not null default 0, updated_at timestamptz not null default now()
);
create table if not exists public.activation_codes (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
  code_hash text not null, expires_at timestamptz not null, used_at timestamptz, failed_attempts integer not null default 0,
  locked_until timestamptz, created_at timestamptz not null default now()
);
create unique index if not exists activation_codes_one_live_idx on public.activation_codes(user_id) where used_at is null;
create table if not exists public.nickname_history (
  id bigint generated always as identity primary key, user_id uuid not null references public.profiles(id) on delete cascade,
  old_nickname text, new_nickname text not null, changed_at timestamptz not null default now()
);
create table if not exists public.lottery_weeks (
  id uuid primary key default gen_random_uuid(), title text not null, draw_date timestamptz, is_current boolean not null default false,
  is_open boolean not null default true, created_by uuid references auth.users(id), created_at timestamptz not null default now()
);
create table if not exists public.member_week_sequences (
  id uuid primary key default gen_random_uuid(), week_id uuid not null references public.lottery_weeks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade, sequence_no integer not null check(sequence_no > 0), created_at timestamptz not null default now(),
  unique(week_id,user_id), unique(week_id,sequence_no)
);
create table if not exists public.lottery_batches (
  id uuid primary key default gen_random_uuid(), week_id uuid not null references public.lottery_weeks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade, sequence_no integer, status public.entry_status not null default 'draft',
  total_amount numeric(14,2) not null default 0 check(total_amount >= 0), created_by uuid references auth.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), submitted_at timestamptz, submitted_by uuid references auth.users(id),
  dealer_confirmed_at timestamptz, dealer_confirmed_by uuid references auth.users(id), approved_at timestamptz, approved_by uuid references auth.users(id),
  rejected_at timestamptz, rejected_by uuid references auth.users(id), cancelled_at timestamptz, cancelled_by uuid references auth.users(id)
);
create unique index if not exists lottery_batches_active_user_week_idx on public.lottery_batches(user_id,week_id) where status <> 'cancelled';
create index if not exists lottery_batches_user_week_idx on public.lottery_batches(user_id,week_id);
create table if not exists public.lottery_entries (
  id uuid primary key default gen_random_uuid(), batch_id uuid not null references public.lottery_batches(id) on delete cascade,
  week_id uuid not null references public.lottery_weeks(id) on delete cascade, user_id uuid not null references public.profiles(id) on delete cascade,
  number text not null check(number ~ '^[0-9]{3}$'), amount numeric(14,2) not null check(amount > 0), is_closed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists lottery_entries_user_week_idx on public.lottery_entries(user_id,week_id);
create index if not exists lottery_entries_batch_idx on public.lottery_entries(batch_id);
create table if not exists public.closed_numbers (
  id uuid primary key default gen_random_uuid(), week_id uuid not null references public.lottery_weeks(id) on delete cascade,
  number text not null check(number ~ '^[0-9]{3}$'), reason text, created_by uuid references auth.users(id), created_at timestamptz not null default now(), unique(week_id,number)
);
create table if not exists public.lottery_results (
  id uuid primary key default gen_random_uuid(), week_id uuid not null unique references public.lottery_weeks(id) on delete cascade,
  result_number text not null check(result_number ~ '^[0-9]{3}$'), published_by uuid references auth.users(id), published_at timestamptz not null default now()
);
create table if not exists public.community_activity (
  id uuid primary key default gen_random_uuid(), actor_user_id uuid references public.profiles(id) on delete set null,
  nickname_snapshot text, masked_id_snapshot text, avatar_key_snapshot text, activity_type text not null,
  safe_payload jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(),
  constraint safe_community_payload check(not (safe_payload ?| array['generated_name','user_id','pin','activation_code','internal_email']))
);
create index if not exists community_activity_created_idx on public.community_activity(created_at desc);
create table if not exists public.community_reactions (
  id uuid primary key default gen_random_uuid(), activity_id uuid not null references public.community_activity(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade, reaction text not null check(reaction in ('👏','🔥','😂','😭','🍀','🎉','❤️')),
  created_at timestamptz not null default now(), unique(activity_id,user_id,reaction)
);
create index if not exists reaction_throttle_idx on public.community_reactions(user_id,created_at desc);
create table if not exists public.dream100_items (
  id uuid primary key default gen_random_uuid(), title_mm text not null, title_en text, keywords text[] not null default '{}', numbers text[] not null default '{}',
  emoji text, short_description text, category text, is_active boolean not null default true, created_by uuid references auth.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint dream_numbers_valid check(array_to_string(numbers, ',') ~ '^([0-9]{1,3})(,[0-9]{1,3})*$' or cardinality(numbers)=0)
);
create table if not exists public.login_security_events (
  id bigint generated always as identity primary key, generated_name_hash text, ip_hash text, event_type text not null,
  created_at timestamptz not null default now()
);
create index if not exists login_security_account_idx on public.login_security_events(generated_name_hash,created_at desc);
create index if not exists login_security_ip_idx on public.login_security_events(ip_hash,created_at desc);
create table if not exists public.audit_logs (
  id bigint generated always as identity primary key, actor_id uuid references auth.users(id), action text not null,
  entity_type text, entity_id text, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(),
  constraint audit_no_credentials check(not (metadata ?| array['pin','activation_code','code_hash','internal_email','password','pepper']))
);

create or replace function public.set_updated_at() returns trigger language plpgsql set search_path='' as $$ begin new.updated_at=now(); return new; end $$;
drop trigger if exists profiles_set_updated_at on public.profiles; create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
drop trigger if exists lottery_batches_set_updated_at on public.lottery_batches; create trigger lottery_batches_set_updated_at before update on public.lottery_batches for each row execute function public.set_updated_at();
drop trigger if exists dream100_set_updated_at on public.dream100_items; create trigger dream100_set_updated_at before update on public.dream100_items for each row execute function public.set_updated_at();

create or replace function public.mask_generated_name(value text) returns text language sql immutable set search_path='' as $$
 select case when value is null then null when length(value)<=6 then left(value,3)||'***' else left(value,4)||'***'||right(value,2) end;
$$;
create or replace function public.current_app_role() returns public.app_role language sql stable security definer set search_path=public as $$ select role from public.profiles where id=auth.uid() $$;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path=public as $$ select coalesce((select role='admin' from public.profiles where id=auth.uid() and is_active),false) $$;
create or replace function public.is_staff_or_admin() returns boolean language sql stable security definer set search_path=public as $$ select coalesce((select role in ('admin','staff') from public.profiles where id=auth.uid() and is_active),false) $$;

create or replace function public.update_my_profile(p_nickname text,p_avatar_key text) returns void language plpgsql security definer set search_path=public as $$
declare old_name text; allowed text[]:=array['cat-01','panda-03','fox-02','car-01','sports-car-02','supercar-05','motorbike-01','scooter-02','male-04','female-08','cartoon-11','robot-03','gaming-01','space-02','lucky-clover-01','moon-02','flower-03','wizard-01','dragon-02','food-01'];
begin
 if auth.uid() is null then raise exception 'Not authenticated'; end if;
 if char_length(trim(p_nickname)) not between 1 and 30 then raise exception 'Invalid nickname'; end if;
 if not(p_avatar_key=any(allowed)) then raise exception 'Invalid avatar'; end if;
 select nickname into old_name from public.profiles where id=auth.uid() for update;
 update public.profiles set nickname=trim(p_nickname),avatar_key=p_avatar_key,nickname_updated_at=case when nickname is distinct from trim(p_nickname) then now() else nickname_updated_at end where id=auth.uid() and is_active;
 if old_name is distinct from trim(p_nickname) then insert into public.nickname_history(user_id,old_nickname,new_nickname) values(auth.uid(),old_name,trim(p_nickname)); end if;
end $$;

create or replace function public.add_community_reaction(p_activity_id uuid,p_reaction text) returns void language plpgsql security definer set search_path=public as $$
begin
 if p_reaction not in ('👏','🔥','😂','😭','🍀','🎉','❤️') then raise exception 'Invalid reaction'; end if;
 if (select count(*) from community_reactions where user_id=auth.uid() and created_at>now()-interval '1 minute')>=12 then raise exception 'Too many reactions'; end if;
 insert into community_reactions(activity_id,user_id,reaction) values(p_activity_id,auth.uid(),p_reaction) on conflict do nothing;
end $$;

-- Privileged transaction called only by Edge Functions with the service-role client.
create or replace function public.approve_batch_atomic(p_batch_id uuid,p_actor_id uuid) returns public.lottery_batches language plpgsql security definer set search_path=public as $$
declare b public.lottery_batches; p public.profiles; total numeric;
begin
 if not exists(select 1 from profiles where id=p_actor_id and role='admin' and is_active) then raise exception 'Forbidden'; end if;
 select * into b from lottery_batches where id=p_batch_id for update;
 if b.id is null or b.status not in ('pending','sent_to_dealer') or b.dealer_confirmed_at is null then raise exception 'Batch is not ready'; end if;
 select coalesce(sum(amount),0) into total from lottery_entries where batch_id=p_batch_id and not is_closed;
 if total<=0 then raise exception 'Batch has no valid entries'; end if;
 update lottery_batches set status='approved',total_amount=total,approved_at=now(),approved_by=p_actor_id where id=p_batch_id returning * into b;
 select * into p from profiles where id=b.user_id;
 insert into community_activity(actor_user_id,nickname_snapshot,masked_id_snapshot,avatar_key_snapshot,activity_type,safe_payload)
 values(p.id,p.nickname,mask_generated_name(p.generated_name),p.avatar_key,'batch_approved',jsonb_build_object('week_id',b.week_id,'message_type','batch_approved'));
 insert into audit_logs(actor_id,action,entity_type,entity_id,metadata) values(p_actor_id,'BATCH_APPROVED','lottery_batch',b.id::text,jsonb_build_object('total_amount',total,'user_id',b.user_id));
 return b;
end $$;

create or replace function public.save_batch_atomic(p_batch_id uuid,p_week_id uuid,p_user_id uuid,p_entries jsonb,p_actor_id uuid) returns public.lottery_batches language plpgsql security definer set search_path=public as $$
declare b public.lottery_batches; seq integer; item jsonb; number_value text; amount_value numeric; closed boolean;
begin
 if not exists(select 1 from profiles where id=p_actor_id and role in ('admin','staff') and is_active) then raise exception 'Forbidden'; end if;
 if not exists(select 1 from profiles where id=p_user_id and role='user' and is_active) or not exists(select 1 from lottery_weeks where id=p_week_id and is_open) then raise exception 'Invalid target'; end if;
 if jsonb_typeof(p_entries)<>'array' or jsonb_array_length(p_entries)=0 or jsonb_array_length(p_entries)>500 then raise exception 'Invalid entries'; end if;
 perform pg_advisory_xact_lock(hashtext(p_week_id::text));
 if p_batch_id is null then
   select coalesce(max(sequence_no),0)+1 into seq from member_week_sequences where week_id=p_week_id;
   insert into member_week_sequences(week_id,user_id,sequence_no) values(p_week_id,p_user_id,seq) on conflict(week_id,user_id) do update set user_id=excluded.user_id returning sequence_no into seq;
   insert into lottery_batches(week_id,user_id,sequence_no,status,created_by) values(p_week_id,p_user_id,seq,'draft',p_actor_id) returning * into b;
 else
   select * into b from lottery_batches where id=p_batch_id for update;
   if b.id is null or b.week_id<>p_week_id or b.user_id<>p_user_id or b.status not in ('draft','pending') then raise exception 'Batch cannot be edited'; end if;
   delete from lottery_entries where batch_id=b.id;
 end if;
 for item in select * from jsonb_array_elements(p_entries) loop
   number_value:=item->>'number'; amount_value:=(item->>'amount')::numeric;
   if number_value !~ '^[0-9]{3}$' or amount_value<=0 then raise exception 'Invalid entry'; end if;
   select exists(select 1 from closed_numbers where week_id=p_week_id and number=number_value) into closed;
   if closed then raise exception '% သည် ပိတ်ဂဏန်းဖြစ်ပါသည်။',number_value; end if;
   insert into lottery_entries(batch_id,week_id,user_id,number,amount,is_closed) values(b.id,p_week_id,p_user_id,number_value,amount_value,false);
 end loop;
 update lottery_batches set total_amount=(select sum(amount) from lottery_entries where batch_id=b.id),status='pending',submitted_at=coalesce(submitted_at,now()),submitted_by=coalesce(submitted_by,p_actor_id) where id=b.id returning * into b;
 insert into audit_logs(actor_id,action,entity_type,entity_id,metadata) values(p_actor_id,case when p_batch_id is null then 'BATCH_CREATED' else 'BATCH_EDITED' end,'lottery_batch',b.id::text,jsonb_build_object('entry_count',jsonb_array_length(p_entries),'user_id',p_user_id));
 return b;
end $$;

create or replace function public.confirm_dealer_atomic(p_batch_id uuid,p_actor_id uuid) returns public.lottery_batches language plpgsql security definer set search_path=public as $$
declare b public.lottery_batches;
begin
 if not exists(select 1 from profiles where id=p_actor_id and role in ('admin','staff') and is_active) then raise exception 'Forbidden'; end if;
 select * into b from lottery_batches where id=p_batch_id for update;
 if b.status<>'pending' then raise exception 'Invalid status'; end if;
 update lottery_batches set status='sent_to_dealer',dealer_confirmed_at=now(),dealer_confirmed_by=p_actor_id where id=p_batch_id returning * into b;
 insert into audit_logs(actor_id,action,entity_type,entity_id) values(p_actor_id,'SENT_TO_DEALER','lottery_batch',p_batch_id::text); return b;
end $$;

create or replace function public.reject_batch_atomic(p_batch_id uuid,p_actor_id uuid,p_reason text default null) returns public.lottery_batches language plpgsql security definer set search_path=public as $$
declare b public.lottery_batches;
begin
 if not exists(select 1 from profiles where id=p_actor_id and role='admin' and is_active) then raise exception 'Forbidden'; end if;
 select * into b from lottery_batches where id=p_batch_id for update; if b.status not in ('pending','sent_to_dealer') then raise exception 'Invalid status'; end if;
 update lottery_batches set status='rejected',rejected_at=now(),rejected_by=p_actor_id where id=p_batch_id returning * into b;
 insert into audit_logs(actor_id,action,entity_type,entity_id,metadata) values(p_actor_id,'BATCH_REJECTED','lottery_batch',p_batch_id::text,jsonb_build_object('reason',left(coalesce(p_reason,''),200)));return b;
end $$;

create or replace function public.publish_result_atomic(p_week_id uuid,p_result text,p_actor_id uuid) returns public.lottery_results language plpgsql security definer set search_path=public as $$
declare r public.lottery_results;
begin
 if not exists(select 1 from profiles where id=p_actor_id and role='admin' and is_active) then raise exception 'Forbidden'; end if;
 if p_result !~ '^[0-9]{3}$' then raise exception 'Invalid result'; end if;
 insert into lottery_results(week_id,result_number,published_by) values(p_week_id,p_result,p_actor_id)
 on conflict(week_id) do update set result_number=excluded.result_number,published_by=excluded.published_by,published_at=now() returning * into r;
 update lottery_weeks set is_open=false where id=p_week_id;
 insert into audit_logs(actor_id,action,entity_type,entity_id,metadata) values(p_actor_id,'RESULT_PUBLISHED','lottery_week',p_week_id::text,jsonb_build_object('result_number',p_result));return r;
end $$;

alter table public.profiles enable row level security; alter table public.auth_identities enable row level security; alter table public.activation_codes enable row level security;
alter table public.nickname_history enable row level security; alter table public.lottery_weeks enable row level security; alter table public.member_week_sequences enable row level security;
alter table public.lottery_batches enable row level security; alter table public.lottery_entries enable row level security; alter table public.closed_numbers enable row level security;
alter table public.lottery_results enable row level security; alter table public.community_activity enable row level security; alter table public.community_reactions enable row level security;
alter table public.dream100_items enable row level security; alter table public.login_security_events enable row level security; alter table public.audit_logs enable row level security;

drop policy if exists "profiles own or staff read" on public.profiles; create policy "profiles own or staff read" on public.profiles for select to authenticated using(id=(select auth.uid()) or public.is_staff_or_admin());
drop policy if exists "nickname history own or admin" on public.nickname_history; create policy "nickname history own or admin" on public.nickname_history for select to authenticated using(user_id=(select auth.uid()) or public.is_admin());
drop policy if exists "authenticated read weeks" on public.lottery_weeks; create policy "authenticated read weeks" on public.lottery_weeks for select to authenticated using(true);
drop policy if exists "sequences own or staff" on public.member_week_sequences; create policy "sequences own or staff" on public.member_week_sequences for select to authenticated using(user_id=(select auth.uid()) or public.is_staff_or_admin());
drop policy if exists "users read own batches" on public.lottery_batches; create policy "users read own batches" on public.lottery_batches for select to authenticated using(user_id=(select auth.uid()) or public.is_staff_or_admin());
drop policy if exists "users read own entries" on public.lottery_entries; create policy "users read own entries" on public.lottery_entries for select to authenticated using(user_id=(select auth.uid()) or public.is_staff_or_admin());
drop policy if exists "staff read closed numbers" on public.closed_numbers; create policy "staff read closed numbers" on public.closed_numbers for select to authenticated using(public.is_staff_or_admin());
drop policy if exists "authenticated read results" on public.lottery_results; create policy "authenticated read results" on public.lottery_results for select to authenticated using(true);
drop policy if exists "authenticated read safe community" on public.community_activity; create policy "authenticated read safe community" on public.community_activity for select to authenticated using(true);
drop policy if exists "authenticated read reactions" on public.community_reactions; create policy "authenticated read reactions" on public.community_reactions for select to authenticated using(true);
drop policy if exists "authenticated read active dream100" on public.dream100_items; create policy "authenticated read active dream100" on public.dream100_items for select to authenticated using(is_active or public.is_admin());
drop policy if exists "admin reads audit" on public.audit_logs; create policy "admin reads audit" on public.audit_logs for select to authenticated using(public.is_admin());

revoke all on public.auth_identities,public.activation_codes,public.login_security_events from anon,authenticated;
revoke insert,update,delete on public.audit_logs,public.lottery_batches,public.lottery_entries,public.lottery_results,public.closed_numbers,public.member_week_sequences from anon,authenticated;
revoke insert,update,delete on public.community_reactions from anon,authenticated;
revoke update on public.profiles from anon,authenticated;
grant execute on function public.update_my_profile(text,text),public.add_community_reaction(uuid,text) to authenticated;
revoke execute on function public.approve_batch_atomic(uuid,uuid) from public,anon,authenticated;
revoke execute on function public.save_batch_atomic(uuid,uuid,uuid,jsonb,uuid),public.confirm_dealer_atomic(uuid,uuid),public.reject_batch_atomic(uuid,uuid,text),public.publish_result_atomic(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.approve_batch_atomic(uuid,uuid),public.save_batch_atomic(uuid,uuid,uuid,jsonb,uuid),public.confirm_dealer_atomic(uuid,uuid),public.reject_batch_atomic(uuid,uuid,text),public.publish_result_atomic(uuid,text,uuid) to service_role;

-- Realtime publication is additive and idempotent.
do $$ begin alter publication supabase_realtime add table public.lottery_batches; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.community_activity; exception when duplicate_object then null; end $$;

do $$
begin
 if not exists(select 1 from public.dream100_items) then
  insert into public.dream100_items(title_mm,title_en,keywords,numbers,emoji,short_description,category) values
   ('မြွေ','Snake',array['မြွေ','snake','နဂါး'],array['12','72','27'],'🐍','အပြောင်းအလဲနှင့် သတိရှိမှုကို ကိုယ်စားပြုသည့် ရိုးရာအိပ်မက်သင်္ကေတ။','Animals'),
   ('ကျား','Tiger',array['ကျား','tiger','တော'],array['19','91','59'],'🐯','ရဲရင့်မှုနှင့် ခွန်အားကို ကိုယ်စားပြုသည့် သင်္ကေတ။','Animals'),
   ('ငါး','Fish',array['ငါး','fish','ရေ'],array['24','42','82'],'🐟','စီးဆင်းမှု၊ ငြိမ်းချမ်းမှုနှင့် ပေါများမှုကို ပြောပြသည့် သင်္ကေတ။','Animals'),
   ('လမင်း','Moon',array['လ','လမင်း','moon','ည'],array['02','20','29'],'🌙','စိတ်ကူးယဉ်မှုနှင့် ညင်သာသော အတွေးများ၏ သင်္ကေတ။','Nature'),
   ('မိုးရွာ','Rain',array['မိုး','မိုးရွာ','rain','ရေ'],array['14','41','64'],'🌧️','အသစ်ပြန်လည်စတင်ခြင်းနှင့် စိတ်အေးချမ်းမှုကို ကိုယ်စားပြုသည်။','Nature'),
   ('ပန်း','Flower',array['ပန်း','flower','ပွင့်'],array['16','61','06'],'🌸','ကြီးထွားမှုနှင့် ပျော်ရွှင်မှုကို ကိုယ်စားပြုသည့် သင်္ကေတ။','Nature'),
   ('ကား','Car',array['ကား','car','မောင်း'],array['35','53','85'],'🚗','ခရီးစဉ်နှင့် မိမိရွေးချယ်ထားသော လမ်းကြောင်း၏ သင်္ကေတ။','Things'),
   ('ရွှေ','Gold',array['ရွှေ','gold','လက်ဝတ်'],array['08','80','88'],'✨','တန်ဖိုးထားမှုနှင့် တောက်ပသည့်မျှော်လင့်ချက်ကို ကိုယ်စားပြုသည်။','Things'),
   ('ကလေး','Baby',array['ကလေး','baby','သား'],array['01','10','31'],'👶','အစပြုမှုအသစ်နှင့် အပြစ်ကင်းစင်မှု၏ သင်္ကေတ။','People'),
   ('ပျံသန်းခြင်း','Flying',array['ပျံ','ပျံသန်း','flying','ကောင်းကင်'],array['17','71','77'],'🪽','လွတ်လပ်မှုနှင့် ကန့်သတ်ချက်များကို ကျော်လွန်လိုစိတ်၏ သင်္ကေတ။','Actions');
 end if;
end $$;
