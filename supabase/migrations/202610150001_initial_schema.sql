create extension if not exists pgcrypto;

create sequence if not exists public.collection_receipt_seq;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(trim(display_name)) between 1 and 120),
  role text not null default 'collector' check (role in ('admin', 'collector')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  customer_code text not null unique,
  full_name text not null check (length(trim(full_name)) between 1 and 160),
  phone text,
  address text,
  collector_id uuid not null references public.profiles(id),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.collection_entries (
  id uuid primary key default gen_random_uuid(),
  receipt_number text not null unique,
  customer_id uuid not null references public.customers(id),
  collector_id uuid not null references public.profiles(id),
  amount_paise bigint not null check (amount_paise > 0 and amount_paise <= 9000000000000000),
  collected_at timestamptz not null,
  payment_method text not null check (payment_method in ('cash', 'upi', 'bank_transfer', 'other')),
  notes text check (notes is null or length(notes) <= 1000),
  status text not null default 'posted' check (status in ('posted', 'reversed')),
  idempotency_key uuid not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (created_by, idempotency_key)
);

create table public.collection_revisions (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.collection_entries(id),
  previous_values jsonb not null,
  new_values jsonb not null,
  actor_id uuid not null references public.profiles(id),
  action text not null check (action in ('edited', 'reversed')),
  reason text not null check (length(trim(reason)) between 3 and 1000),
  created_at timestamptz not null default now()
);

create table public.collection_reversals (
  id uuid primary key default gen_random_uuid(),
  original_entry_id uuid not null unique references public.collection_entries(id),
  reason text not null check (length(trim(reason)) between 3 and 1000),
  actor_id uuid not null references public.profiles(id),
  replacement_entry_id uuid references public.collection_entries(id),
  created_at timestamptz not null default now()
);

create table public.business_settings (
  id boolean primary key default true check (id),
  business_name text not null default 'Daily Collection Pro',
  currency text not null default 'INR' check (currency = 'INR'),
  receipt_prefix text not null default 'DCP' check (receipt_prefix ~ '^[A-Z0-9]{2,8}$'),
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.business_settings (id) values (true) on conflict (id) do nothing;

create index customers_collector_status_idx on public.customers (collector_id, status, full_name);
create index collection_entries_collector_date_idx on public.collection_entries (collector_id, collected_at desc);
create index collection_entries_customer_date_idx on public.collection_entries (customer_id, collected_at desc);
create index collection_entries_date_status_idx on public.collection_entries (collected_at desc, status);
create index collection_revisions_entry_created_idx on public.collection_revisions (entry_id, created_at desc);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at before update on public.profiles
for each row execute function public.touch_updated_at();
create trigger customers_touch_updated_at before update on public.customers
for each row execute function public.touch_updated_at();
create trigger collection_entries_touch_updated_at before update on public.collection_entries
for each row execute function public.touch_updated_at();

create or replace function public.validate_customer_collector()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  assigned_profile public.profiles;
begin
  if tg_op = 'INSERT' then
    select * into assigned_profile from public.profiles p where p.id = new.collector_id;
    if assigned_profile.id is null or assigned_profile.role <> 'collector' or assigned_profile.active is not true then
      raise exception 'Customer must be assigned to an active collector account';
    end if;
  elsif new.collector_id is distinct from old.collector_id then
    select * into assigned_profile from public.profiles p where p.id = new.collector_id;
    if assigned_profile.id is null or assigned_profile.role <> 'collector' or assigned_profile.active is not true then
      raise exception 'Customer must be assigned to an active collector account';
    end if;
  end if;
  return new;
end;
$$;

create trigger customers_validate_collector before insert or update of collector_id on public.customers
for each row execute function public.validate_customer_collector();

create or replace function public.provision_collector_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1)),
    'collector'
  );
  return new;
end;
$$;

create trigger auth_user_profile_created after insert on auth.users
for each row execute function public.provision_collector_profile();

create or replace function public.current_active_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from public.profiles p
  where p.id = (select auth.uid()) and p.active = true
$$;

create or replace function public.current_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_active_role() = 'admin', false)
$$;

create or replace function public.set_collector_active(p_collector_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.current_is_admin() then raise exception 'Administrator access required'; end if;
  if p_collector_id = auth.uid() then raise exception 'Administrators cannot deactivate their own account'; end if;
  update public.profiles p set active = p_active
  where p.id = p_collector_id and p.role = 'collector';
  if not found then raise exception 'Collector account not found'; end if;
end;
$$;

alter table public.profiles enable row level security;
alter table public.customers enable row level security;
alter table public.collection_entries enable row level security;
alter table public.collection_revisions enable row level security;
alter table public.collection_reversals enable row level security;
alter table public.business_settings enable row level security;

create policy profiles_read_self_or_admin on public.profiles
for select to authenticated
using (id = (select auth.uid()) or public.current_is_admin());

create policy customers_read_assigned_or_admin on public.customers
for select to authenticated
using (public.current_is_admin() or (public.current_active_role() = 'collector' and collector_id = (select auth.uid())));
create policy customers_admin_insert on public.customers
for insert to authenticated with check (public.current_is_admin());
create policy customers_admin_update on public.customers
for update to authenticated using (public.current_is_admin()) with check (public.current_is_admin());

create policy collections_read_own_or_admin on public.collection_entries
for select to authenticated
using (public.current_is_admin() or (public.current_active_role() = 'collector' and collector_id = (select auth.uid())));

create policy revisions_read_own_or_admin on public.collection_revisions
for select to authenticated
using (
  public.current_is_admin()
  or exists (
    select 1 from public.collection_entries e
    where e.id = entry_id and e.collector_id = (select auth.uid())
  )
);

create policy reversals_read_admin on public.collection_reversals
for select to authenticated using (public.current_is_admin());

create policy settings_read_active on public.business_settings
for select to authenticated using (public.current_active_role() is not null);
create policy settings_admin_update on public.business_settings
for update to authenticated using (public.current_is_admin()) with check (public.current_is_admin());

create or replace function public.submit_collection(
  p_customer_id uuid,
  p_amount_paise bigint,
  p_collected_at timestamptz,
  p_payment_method text,
  p_notes text,
  p_idempotency_key uuid
)
returns public.collection_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := public.current_active_role();
  target_collector uuid;
  receipt_prefix text;
  inserted_entry public.collection_entries;
begin
  if actor_id is null or actor_role is null then raise exception 'Active account required'; end if;
  if p_amount_paise is null or p_amount_paise <= 0 or p_amount_paise > 9000000000000000 then raise exception 'Amount must be a positive valid paise value'; end if;
  if p_collected_at is null then raise exception 'Collection time is required'; end if;
  if p_payment_method not in ('cash', 'upi', 'bank_transfer', 'other') then raise exception 'Invalid payment method'; end if;
  if p_idempotency_key is null then raise exception 'Idempotency key is required'; end if;
  if p_notes is not null and length(p_notes) > 1000 then raise exception 'Notes are too long'; end if;

  select * into inserted_entry from public.collection_entries e
  where e.created_by = actor_id and e.idempotency_key = p_idempotency_key;
  if inserted_entry.id is not null then
    if inserted_entry.customer_id is distinct from p_customer_id
      or inserted_entry.amount_paise is distinct from p_amount_paise
      or inserted_entry.collected_at is distinct from p_collected_at
      or inserted_entry.payment_method is distinct from p_payment_method
      or inserted_entry.notes is distinct from nullif(trim(p_notes), '') then
      raise exception 'Idempotency key was already used with different collection details';
    end if;
    return inserted_entry;
  end if;

  select c.collector_id into target_collector
  from public.customers c
  where c.id = p_customer_id and c.status = 'active'
    and exists (
      select 1 from public.profiles p
      where p.id = c.collector_id and p.role = 'collector' and p.active = true
    )
    and (actor_role = 'admin' or c.collector_id = actor_id);
  if target_collector is null then raise exception 'Customer is unavailable to this account'; end if;

  select s.receipt_prefix into receipt_prefix from public.business_settings s where s.id = true;
  insert into public.collection_entries (
    receipt_number, customer_id, collector_id, amount_paise, collected_at,
    payment_method, notes, idempotency_key, created_by
  ) values (
    receipt_prefix || '-' || to_char((p_collected_at at time zone 'Asia/Kolkata')::date, 'YYYYMMDD') || '-' ||
      lpad(nextval('public.collection_receipt_seq')::text, 8, '0'),
    p_customer_id, target_collector, p_amount_paise, p_collected_at,
    p_payment_method, nullif(trim(p_notes), ''), p_idempotency_key, actor_id
  ) on conflict (created_by, idempotency_key) do nothing
  returning * into inserted_entry;

  if inserted_entry.id is null then
    select * into inserted_entry from public.collection_entries e
    where e.created_by = actor_id and e.idempotency_key = p_idempotency_key;
    if inserted_entry.id is null then raise exception 'Collection retry could not be confirmed'; end if;
    if inserted_entry.customer_id is distinct from p_customer_id
      or inserted_entry.amount_paise is distinct from p_amount_paise
      or inserted_entry.collected_at is distinct from p_collected_at
      or inserted_entry.payment_method is distinct from p_payment_method
      or inserted_entry.notes is distinct from nullif(trim(p_notes), '') then
      raise exception 'Idempotency key was already used with different collection details';
    end if;
  end if;
  return inserted_entry;
end;
$$;

create or replace function public.edit_collection(
  p_entry_id uuid,
  p_amount_paise bigint,
  p_collected_at timestamptz,
  p_payment_method text,
  p_notes text,
  p_reason text
)
returns public.collection_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  before_values jsonb;
  after_values jsonb;
  updated_entry public.collection_entries;
begin
  if not public.current_is_admin() then raise exception 'Administrator access required'; end if;
  if p_amount_paise is null or p_amount_paise <= 0 or p_amount_paise > 9000000000000000 then raise exception 'Amount must be a positive valid paise value'; end if;
  if p_collected_at is null or p_payment_method not in ('cash', 'upi', 'bank_transfer', 'other') then raise exception 'Invalid collection details'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'An edit reason of at least 3 characters is required'; end if;
  if p_notes is not null and length(p_notes) > 1000 then raise exception 'Notes are too long'; end if;

  select to_jsonb(e) - 'idempotency_key' into before_values
  from public.collection_entries e where e.id = p_entry_id and e.status = 'posted' for update;
  if before_values is null then raise exception 'Posted collection not found'; end if;

  update public.collection_entries e set
    amount_paise = p_amount_paise, collected_at = p_collected_at,
    payment_method = p_payment_method, notes = nullif(trim(p_notes), '')
  where e.id = p_entry_id returning * into updated_entry;

  after_values := to_jsonb(updated_entry) - 'idempotency_key';
  insert into public.collection_revisions (entry_id, previous_values, new_values, actor_id, action, reason)
  values (p_entry_id, before_values, after_values, actor_id, 'edited', trim(p_reason));
  return updated_entry;
end;
$$;

create or replace function public.reverse_collection(p_entry_id uuid, p_reason text)
returns public.collection_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  before_values jsonb;
  updated_entry public.collection_entries;
begin
  if not public.current_is_admin() then raise exception 'Administrator access required'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'A reversal reason of at least 3 characters is required'; end if;
  select to_jsonb(e) - 'idempotency_key' into before_values
  from public.collection_entries e where e.id = p_entry_id and e.status = 'posted' for update;
  if before_values is null then raise exception 'Posted collection not found'; end if;

  update public.collection_entries e set status = 'reversed' where e.id = p_entry_id returning * into updated_entry;
  insert into public.collection_reversals (original_entry_id, reason, actor_id)
  values (p_entry_id, trim(p_reason), actor_id);
  insert into public.collection_revisions (entry_id, previous_values, new_values, actor_id, action, reason)
  values (p_entry_id, before_values, to_jsonb(updated_entry) - 'idempotency_key', actor_id, 'reversed', trim(p_reason));
  return updated_entry;
end;
$$;

create or replace function public.search_collection_entries(
  p_search text default null,
  p_collector_id uuid default null,
  p_customer_id uuid default null,
  p_payment_method text default null,
  p_from timestamptz default null,
  p_until timestamptz default null
)
returns setof public.collection_entries
language sql
stable
security invoker
set search_path = ''
as $$
  select e.*
  from public.collection_entries e
  join public.customers c on c.id = e.customer_id
  where (nullif(trim(p_search), '') is null or
    position(lower(trim(p_search)) in lower(concat_ws(' ', e.receipt_number, e.notes, c.full_name, c.customer_code))) > 0)
    and (p_collector_id is null or e.collector_id = p_collector_id)
    and (p_customer_id is null or e.customer_id = p_customer_id)
    and (p_payment_method is null or e.payment_method = p_payment_method)
    and (p_from is null or e.collected_at >= p_from)
    and (p_until is null or e.collected_at < p_until)
$$;

create or replace function public.dashboard_summary()
returns table (today_total_paise text, today_count bigint, cash_total_paise text, digital_total_paise text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  india_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if public.current_active_role() is null then raise exception 'Active account required'; end if;
  return query
  select
    coalesce(sum(e.amount_paise) filter (where e.status = 'posted' and e.collected_at >= india_today::timestamp at time zone 'Asia/Kolkata' and e.collected_at < (india_today + 1)::timestamp at time zone 'Asia/Kolkata'), 0)::text,
    count(*) filter (where e.status = 'posted' and e.collected_at >= india_today::timestamp at time zone 'Asia/Kolkata' and e.collected_at < (india_today + 1)::timestamp at time zone 'Asia/Kolkata'),
    coalesce(sum(e.amount_paise) filter (where e.status = 'posted' and e.payment_method = 'cash' and e.collected_at >= india_today::timestamp at time zone 'Asia/Kolkata' and e.collected_at < (india_today + 1)::timestamp at time zone 'Asia/Kolkata'), 0)::text,
    coalesce(sum(e.amount_paise) filter (where e.status = 'posted' and e.payment_method <> 'cash' and e.collected_at >= india_today::timestamp at time zone 'Asia/Kolkata' and e.collected_at < (india_today + 1)::timestamp at time zone 'Asia/Kolkata'), 0)::text
  from public.collection_entries e;
end;
$$;

create or replace function public.collection_report(p_from timestamptz default null, p_until timestamptz default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  report jsonb;
begin
  if not public.current_is_admin() then raise exception 'Administrator access required'; end if;

  with matching as (
    select e.* from public.collection_entries e
    where (p_from is null or e.collected_at >= p_from)
      and (p_until is null or e.collected_at < p_until)
  ), summary as (
    select
      coalesce(sum(amount_paise) filter (where status = 'posted'), 0) as net_total_paise,
      count(*) filter (where status = 'posted') as posted_count,
      coalesce(sum(amount_paise) filter (where status = 'posted' and payment_method = 'cash'), 0) as cash_total_paise,
      coalesce(sum(amount_paise) filter (where status = 'posted' and payment_method <> 'cash'), 0) as digital_total_paise,
      count(*) filter (where status = 'reversed') as reversed_count
    from matching
  ), collector_totals as (
    select e.collector_id, p.display_name, sum(e.amount_paise) as total_paise, count(*) as transaction_count
    from matching e join public.profiles p on p.id = e.collector_id
    where e.status = 'posted'
    group by e.collector_id, p.display_name
  ), customer_totals as (
    select e.customer_id, c.customer_code, c.full_name, sum(e.amount_paise) as total_paise, count(*) as transaction_count
    from matching e join public.customers c on c.id = e.customer_id
    where e.status = 'posted'
    group by e.customer_id, c.customer_code, c.full_name
  )
  select jsonb_build_object(
    'summary', (select jsonb_build_object(
      'net_total_paise', s.net_total_paise::text,
      'posted_count', s.posted_count,
      'cash_total_paise', s.cash_total_paise::text,
      'digital_total_paise', s.digital_total_paise::text,
      'reversed_count', s.reversed_count
    ) from summary s),
    'collectors', coalesce((select jsonb_agg(jsonb_build_object(
      'collector_id', ct.collector_id,
      'display_name', ct.display_name,
      'total_paise', ct.total_paise::text,
      'transaction_count', ct.transaction_count
    ) order by ct.total_paise desc) from collector_totals ct), '[]'::jsonb),
    'customers', coalesce((select jsonb_agg(jsonb_build_object(
      'customer_id', cu.customer_id,
      'customer_code', cu.customer_code,
      'full_name', cu.full_name,
      'total_paise', cu.total_paise::text,
      'transaction_count', cu.transaction_count
    ) order by cu.total_paise desc) from customer_totals cu), '[]'::jsonb)
  ) into report;
  return report;
end;
$$;

revoke all on public.profiles, public.customers, public.collection_entries,
  public.collection_revisions, public.collection_reversals, public.business_settings from anon;
grant select on public.profiles to authenticated;
grant select, insert, update on public.customers to authenticated;
grant select on public.collection_entries, public.collection_revisions, public.collection_reversals to authenticated;
grant select, update on public.business_settings to authenticated;
revoke all on function public.submit_collection(uuid, bigint, timestamptz, text, text, uuid) from public, anon;
revoke all on function public.edit_collection(uuid, bigint, timestamptz, text, text, text) from public, anon;
revoke all on function public.reverse_collection(uuid, text) from public, anon;
revoke all on function public.dashboard_summary() from public, anon;
revoke all on function public.collection_report(timestamptz, timestamptz) from public, anon;
revoke all on function public.search_collection_entries(text, uuid, uuid, text, timestamptz, timestamptz) from public, anon;
grant execute on function public.submit_collection(uuid, bigint, timestamptz, text, text, uuid) to authenticated;
grant execute on function public.edit_collection(uuid, bigint, timestamptz, text, text, text) to authenticated;
grant execute on function public.reverse_collection(uuid, text) to authenticated;
grant execute on function public.dashboard_summary() to authenticated;
grant execute on function public.collection_report(timestamptz, timestamptz) to authenticated;
grant execute on function public.search_collection_entries(text, uuid, uuid, text, timestamptz, timestamptz) to authenticated;
revoke all on function public.set_collector_active(uuid, boolean) from public, anon;
grant execute on function public.set_collector_active(uuid, boolean) to authenticated;

revoke all on sequence public.collection_receipt_seq from public, anon, authenticated;
