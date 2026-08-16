-- Atomic, single-use activation claims for managed EZWin accounts.
alter table public.profiles add column if not exists activated_at timestamptz;
alter table public.activation_codes add column if not exists claim_token uuid;
alter table public.activation_codes add column if not exists claimed_at timestamptz;
create unique index if not exists activation_codes_claim_token_uidx on public.activation_codes(claim_token) where claim_token is not null;

-- Existing accounts without a live activation code were already usable before this migration.
update public.profiles p set activated_at=coalesce(p.activated_at,p.created_at)
where p.activated_at is null
  and not exists(select 1 from public.activation_codes a where a.user_id=p.id and a.used_at is null);

create or replace function public.claim_activation_atomic(p_generated_name text,p_code_hash text)
returns table(status text,user_id uuid,internal_email text,pin_version integer,claim_token uuid)
language plpgsql security definer set search_path=public as $$
declare
  target_profile public.profiles;
  target_code public.activation_codes;
  target_identity public.auth_identities;
  token uuid;
  attempts integer;
begin
  select * into target_profile from public.profiles
  where lower(generated_name)=lower(trim(p_generated_name)) and is_active
  for update;
  if target_profile.id is null then
    return query select 'ACCOUNT_NOT_FOUND'::text,null::uuid,null::text,null::integer,null::uuid; return;
  end if;

  select * into target_code from public.activation_codes
  where activation_codes.user_id=target_profile.id
  order by created_at desc limit 1 for update;
  if target_code.id is null then
    return query select 'INVALID_ACTIVATION_CODE'::text,null::uuid,null::text,null::integer,null::uuid; return;
  end if;
  if target_code.used_at is not null then
    return query select 'ACTIVATION_CODE_USED'::text,null::uuid,null::text,null::integer,null::uuid; return;
  end if;
  if target_code.expires_at<=now() then
    return query select 'ACTIVATION_CODE_EXPIRED'::text,null::uuid,null::text,null::integer,null::uuid; return;
  end if;
  if target_code.locked_until is not null and target_code.locked_until>now() then
    return query select 'ACTIVATION_CODE_LOCKED'::text,null::uuid,null::text,null::integer,null::uuid; return;
  end if;
  if target_code.claim_token is not null and target_code.claimed_at>now()-interval '5 minutes' then
    return query select 'ACTIVATION_IN_PROGRESS'::text,null::uuid,null::text,null::integer,null::uuid; return;
  end if;
  if target_code.code_hash<>p_code_hash then
    attempts:=target_code.failed_attempts+1;
    update public.activation_codes set failed_attempts=attempts,
      locked_until=case when attempts>=5 then now()+interval '15 minutes' else null end,
      claim_token=null,claimed_at=null
    where id=target_code.id;
    return query select 'INVALID_ACTIVATION_CODE'::text,null::uuid,null::text,null::integer,null::uuid; return;
  end if;

  select * into target_identity from public.auth_identities where auth_identities.user_id=target_profile.id;
  if target_identity.user_id is null then
    return query select 'ACCOUNT_NOT_FOUND'::text,null::uuid,null::text,null::integer,null::uuid; return;
  end if;
  token:=gen_random_uuid();
  update public.activation_codes set claim_token=token,claimed_at=now() where id=target_code.id;
  return query select 'OK'::text,target_profile.id,target_identity.internal_email,target_identity.pin_version,token;
end $$;

create or replace function public.finalize_activation_atomic(p_claim_token uuid,p_nickname text)
returns table(user_id uuid,generated_name text,nickname text,role public.app_role,used_at timestamptz)
language plpgsql security definer set search_path=public as $$
declare target_code public.activation_codes; target_profile public.profiles; old_name text; redeemed_at timestamptz:=now();
begin
  select * into target_code from public.activation_codes
  where claim_token=p_claim_token and activation_codes.used_at is null
  for update;
  if target_code.id is null or target_code.claimed_at<=now()-interval '5 minutes' then raise exception 'INVALID_ACTIVATION_CLAIM'; end if;
  select * into target_profile from public.profiles where id=target_code.user_id for update;
  if target_profile.id is null or not target_profile.is_active then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  if char_length(trim(p_nickname)) not between 1 and 30 then raise exception 'INVALID_NICKNAME'; end if;
  old_name:=target_profile.nickname;
  update public.profiles set nickname=trim(p_nickname),nickname_updated_at=redeemed_at,activated_at=redeemed_at where id=target_profile.id;
  if old_name is distinct from trim(p_nickname) then
    insert into public.nickname_history(user_id,old_nickname,new_nickname) values(target_profile.id,old_name,trim(p_nickname));
  end if;
  update public.activation_codes set used_at=redeemed_at,claim_token=null,claimed_at=null where id=target_code.id;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id) values(target_profile.id,'USER_ACTIVATED','profile',target_profile.id::text);
  return query select target_profile.id,target_profile.generated_name,trim(p_nickname),target_profile.role,redeemed_at;
end $$;

create or replace function public.release_activation_claim(p_claim_token uuid) returns void
language sql security definer set search_path=public as $$
  update public.activation_codes set claim_token=null,claimed_at=null
  where claim_token=p_claim_token and used_at is null;
$$;

revoke execute on function public.claim_activation_atomic(text,text) from public,anon,authenticated;
revoke execute on function public.finalize_activation_atomic(uuid,text) from public,anon,authenticated;
revoke execute on function public.release_activation_claim(uuid) from public,anon,authenticated;
grant execute on function public.claim_activation_atomic(text,text) to service_role;
grant execute on function public.finalize_activation_atomic(uuid,text) to service_role;
grant execute on function public.release_activation_claim(uuid) to service_role;
