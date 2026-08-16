-- Supabase support required by the existing Claude UI account flow only.
-- This is additive and does not alter the visual application.
create table if not exists public.profile_private (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  recovery_email text not null,
  recovery_email_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists profile_private_recovery_email_uidx on public.profile_private(lower(recovery_email));

create table if not exists public.user_roles (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  role public.app_role not null default 'user',
  assigned_by uuid references public.profiles(id),
  assigned_at timestamptz not null default now()
);

create table if not exists public.recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  failed_attempts smallint not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists recovery_codes_user_live_idx on public.recovery_codes(user_id,created_at desc) where used_at is null;

create or replace function public.sync_profile_recovery_email() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  update public.profile_private set recovery_email=new.email,updated_at=now() where user_id=new.id;
  return new;
end $$;
drop trigger if exists ezwin_sync_recovery_email on auth.users;
create trigger ezwin_sync_recovery_email after update of email on auth.users
for each row when(old.email is distinct from new.email)
execute function public.sync_profile_recovery_email();

alter table public.profile_private enable row level security;
alter table public.user_roles enable row level security;
alter table public.recovery_codes enable row level security;

drop policy if exists "users read own role" on public.user_roles;
create policy "users read own role" on public.user_roles for select to authenticated using(user_id=auth.uid() or public.is_admin());

revoke all on public.profile_private, public.recovery_codes from anon, authenticated;
revoke insert, update, delete on public.user_roles from anon, authenticated;
