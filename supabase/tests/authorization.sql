begin;
select plan(22);

insert into auth.users (id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'collector-a@test.invalid', '', '{}', '{"display_name":"Collector A"}', now(), now()),
  ('10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'collector-b@test.invalid', '', '{}', '{"display_name":"Collector B"}', now(), now());

insert into public.customers (id, customer_code, full_name, collector_id)
values
  ('20000000-0000-4000-8000-000000000001', 'TEST-A', 'Test Customer A', '10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000002', 'TEST-B', 'Test Customer B', '10000000-0000-4000-8000-000000000002');

select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;

select is((select role from public.profiles where id = auth.uid()), 'collector', 'auth trigger creates a collector, never an admin');
select throws_ok(
  $$update public.profiles set role = 'admin' where id = auth.uid()$$,
  '42501', 'permission denied for table profiles', 'collector cannot grant themselves admin privileges'
);
select is((select role from public.profiles where id = auth.uid()), 'collector', 'denied role change preserves collector role');
select is((select count(*)::integer from public.customers), 1, 'collector can only read assigned customers');
select is(
  (select count(*)::integer from public.search_collection_entries('Test Customer B', null, null, null, null, null)),
  0,
  'server-side search does not reveal another collector customer'
);
select results_eq(
  $$select full_name from public.customers order by full_name$$,
  $$values ('Test Customer A'::text)$$,
  'collector A cannot read collector B customer details'
);

select lives_ok(
  $$select public.submit_collection('20000000-0000-4000-8000-000000000001', 1250, '2026-10-15 12:00:00+05:30', 'cash', null, '30000000-0000-4000-8000-000000000001')$$,
  'collector can submit a positive collection for an assigned customer'
);
select is((select count(*)::integer from public.collection_entries), 1, 'one receipt is created');
select lives_ok(
  $$select public.submit_collection('20000000-0000-4000-8000-000000000001', 1250, '2026-10-15 12:00:00+05:30', 'cash', null, '30000000-0000-4000-8000-000000000001')$$,
  'a retry with the same idempotency key succeeds without creating another receipt'
);
select is((select count(*)::integer from public.collection_entries), 1, 'idempotent retry does not duplicate financial entry');
select throws_ok(
  $$select public.submit_collection('20000000-0000-4000-8000-000000000001', 1500, '2026-10-15 12:00:00+05:30', 'cash', null, '30000000-0000-4000-8000-000000000001')$$,
  'P0001', 'Idempotency key was already used with different collection details', 'request key cannot be reused for a different amount'
);
select throws_ok(
  $$select public.submit_collection('20000000-0000-4000-8000-000000000001', 0, now(), 'cash', null, '30000000-0000-4000-8000-000000000002')$$,
  'P0001', 'Amount must be a positive valid paise value', 'zero-value collections are rejected'
);
select throws_ok(
  $$select public.edit_collection((select id from public.collection_entries limit 1), 500, now(), 'cash', null, 'unauthorized change')$$,
  'P0001', 'Administrator access required', 'collectors cannot edit ledger entries'
);

reset role;
update public.profiles set role = 'admin' where id = '10000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;

select lives_ok(
  $$select public.edit_collection((select id from public.collection_entries limit 1), 1500, '2026-10-15 12:00:00+05:30', 'upi', 'corrected details', 'Corrected from signed receipt')$$,
  'admin edit succeeds with a reason'
);
select is((select amount_paise::integer from public.collection_entries limit 1), 1500, 'edited amount is persisted');
select is(
  public.collection_report('2026-10-15 00:00:00+05:30', '2026-10-16 00:00:00+05:30')->'summary'->>'net_total_paise',
  '1500',
  'report aggregate returns exact paise as text for the selected India-time day'
);
select is((select count(*)::integer from public.collection_revisions where action = 'edited'), 1, 'edit creates one audit revision');
select is((select previous_values ->> 'amount_paise' from public.collection_revisions where action = 'edited' limit 1), '1250', 'audit revision preserves the prior amount');
select lives_ok(
  $$select public.reverse_collection((select id from public.collection_entries limit 1), 'Duplicate payment confirmed')$$,
  'admin can reverse a posted collection with a reason'
);
select is((select status from public.collection_entries limit 1), 'reversed', 'reversal retains the original ledger row');
select is((select count(*)::integer from public.collection_revisions where action = 'reversed'), 1, 'reversal is recorded in audit history');
select is((select today_total_paise::integer from public.dashboard_summary()), 0, 'reversed entry is excluded from financial totals');

select * from finish();
rollback;