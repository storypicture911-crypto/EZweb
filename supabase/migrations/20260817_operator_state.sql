-- Persistent state for the current Claude UI. Each signed-in account can only
-- read and update its own records. This keeps entry/name/history data portable
-- across the operator's devices without changing the UI component structure.
create table if not exists public.operator_state (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  state_key text not null check(length(state_key) between 1 and 80),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key(owner_id,state_key)
);

alter table public.operator_state enable row level security;

drop policy if exists "owners read operator state" on public.operator_state;
create policy "owners read operator state" on public.operator_state
for select to authenticated using(owner_id=auth.uid());

drop policy if exists "owners insert operator state" on public.operator_state;
create policy "owners insert operator state" on public.operator_state
for insert to authenticated with check(owner_id=auth.uid());

drop policy if exists "owners update operator state" on public.operator_state;
create policy "owners update operator state" on public.operator_state
for update to authenticated using(owner_id=auth.uid()) with check(owner_id=auth.uid());

drop policy if exists "owners delete operator state" on public.operator_state;
create policy "owners delete operator state" on public.operator_state
for delete to authenticated using(owner_id=auth.uid());
