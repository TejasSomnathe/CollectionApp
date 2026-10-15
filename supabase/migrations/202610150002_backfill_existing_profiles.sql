insert into public.profiles (id, display_name, role)
select
  u.id,
  left(
    coalesce(
      nullif(trim(u.raw_user_meta_data ->> 'display_name'), ''),
      nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
      'Collector'
    ),
    120
  ),
  'collector'
from auth.users u
on conflict (id) do nothing;