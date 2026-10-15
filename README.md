# Daily Collection Pro

Responsive React/TypeScript PWA for daily collections, backed by Supabase Auth and PostgreSQL. Money is stored in integer paise. Business-day boundaries and displayed timestamps use `Asia/Kolkata`. There are no seeded or demo financial records.

## Architecture

- Vite, React, TypeScript, Tailwind CSS and a static PWA shell. The service worker caches app assets only; it does not cache Supabase data or queue collection writes.
- Supabase Auth identifies each user. A database trigger creates new profiles as `collector`; only the documented owner bootstrap promotes the first account to `admin`.
- PostgreSQL RLS protects profile, customer, collection, audit, reversal and settings reads/writes. Collection submission, correction, reversal, filtered search, collector activation and summary use database functions. Submission uses a unique actor/idempotency key and exact payload comparison in one transaction for its receipt.
- A Supabase Edge Function validates the signed-in user and active admin role before using the server-only service role key to invite a collector. The key is never sent to the browser.

## Local Setup

Prerequisites: Node.js 22 or newer, npm, Supabase CLI, and access to a Supabase project.

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env.local` and add the project URL and public anon/publishable key. Never add a service-role key to a `VITE_*` variable.
3. Link the CLI to the intended Supabase project using `supabase link --project-ref <project-ref>`.
4. Apply the versioned schema with `supabase db push`.
5. Disable public signups in Supabase Authentication settings. The database trigger assigns every new Auth user the `collector` role regardless; public signup is not an admin creation path.
6. Follow **Initial Admin** below.
7. Set the Edge Function's `APP_ORIGIN` to the deployed app origin, then deploy with `supabase functions deploy create-collector`. Supabase provides the function's URL, anon key and service-role key as runtime environment variables.
8. Run the app with `npm run dev`. Production assets are built with `npm run build`.

### Environment Variables

| Variable                    | Where                               | Purpose                                              |
| --------------------------- | ----------------------------------- | ---------------------------------------------------- |
| `VITE_SUPABASE_URL`         | Browser build                       | Supabase project URL                                 |
| `VITE_SUPABASE_ANON_KEY`    | Browser build                       | Public client key; RLS is the authorization boundary |
| `SUPABASE_URL`              | Supabase Edge Function runtime      | Project URL (provided by Supabase)                   |
| `SUPABASE_ANON_KEY`         | Supabase Edge Function runtime      | Validate caller JWT (provided by Supabase)           |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Edge Function runtime only | Admin invite operation (provided by Supabase)        |
| `APP_ORIGIN`                | Edge Function secret                | Exact production origin for CORS                     |

Use `supabase secrets set APP_ORIGIN=https://your-app.example` to configure the function. Do not commit `.env.local`, database URLs, passwords, tokens or service keys.

## Initial Admin

There is no hardcoded account or password. In the Supabase dashboard, invite the business owner's email through Authentication > Users. The `provision_collector_profile` trigger creates a collector profile. After the owner has accepted the invite, sign in once, confirm the matching Auth user UUID, then run this statement in the Supabase SQL editor as the project owner, replacing the UUID with that verified user's ID:

The follow-up migration `202610150002_backfill_existing_profiles.sql` creates collector profiles for Auth accounts that existed before the trigger was installed. It does not change roles on profiles that already exist. If login reports that a profile row is missing, apply this migration (`supabase db push`, or run this migration's SQL in the Supabase SQL editor after the initial schema migration), then try again.

```sql
update public.profiles
set role = 'admin', active = true
where id = 'REPLACE-WITH-VERIFIED-AUTH-USER-UUID'
  and role = 'collector';
```

Confirm exactly one row changed and verify that account can open the admin pages. Do not expose SQL editor credentials or run this operation from a client. Invited users created through the app always start as collectors.

## Database and Security

The migration in `supabase/migrations/` is version-controlled and includes UUID keys, foreign keys, indexes, positive paise constraints, India-time receipt numbers, RLS, profile provisioning, idempotent collection submission, reasoned edits and reversals with before/after audit rows, configurable business name/receipt prefix, and server-computed daily totals. Reversed ledger rows are retained and excluded from net totals. Ordinary users have no ledger insert/update/delete privileges; collection writes call guarded database functions.

Collector access is scoped to the authenticated profile UUID. Admin pages are also checked by RLS or server/database authorization; hiding a navigation item is not the access control. The `create-collector` Edge Function checks the caller's verified JWT and active admin profile before calling the Auth Admin API.

Audit records are available with each receipt. Before launch, configure Supabase Auth/database log retention and alerts or a log drain for repeated RPC failures, failed Edge Function invitations, and abnormal Auth activity. Monitoring integrations and alert destinations are not configured by this repository.

Run the SQL security tests in a local Supabase instance using `supabase test db`. They cover collector defaults, customer isolation, role escalation, positive amounts, idempotent retries and collector edit denial. The tests have not been run against a hosted project in this workspace. Before launch, also test two real test accounts and direct REST/RPC access, including collector A versus collector B, duplicate concurrent submissions, network failures, edit/reversal audit history, India date boundaries and export output.

## Backups and Recovery

No backup destination or schedule is configured by this repository alone. Supabase plan backups/PITR depend on the selected paid plan and are not an independent copy. The optional GitHub Actions workflow at `.github/workflows/backup.yml` creates encrypted external dumps when explicitly configured.

Set up a separate AWS account or tightly restricted backup account with an S3 bucket that has public access blocked, versioning enabled, server-side KMS encryption, and a 35-day lifecycle/retention rule. Grant the workflow role only the required bucket-prefix write and KMS encrypt permissions; use GitHub OIDC rather than static AWS keys. Configure repository secrets `AWS_BACKUP_ROLE_ARN`, `AWS_BACKUP_BUCKET`, `AWS_BACKUP_REGION`, `AWS_KMS_KEY_ARN`, and `SUPABASE_DB_URL`. The database URL is a secret and must be a direct database connection string with sufficient read privileges. The workflow is not operational until these resources and secrets exist. `SUPABASE_DB_URL` and Auth user/identity data are highly sensitive.

The workflow writes a custom-format `public` dump and a separate data-only Auth users/identities export, uploads checksum sidecars, verifies the app archive's table of contents, and removes its runner-local temporary files. Inspect and retain the workflow run logs without printing secret values. Keep the backup project/bucket in a separate access boundary from the production database.

Recovery drill, performed only in a separate test Supabase project:

1. Download both objects using the restricted backup role, decrypt through AWS KMS, and verify their SHA-256 sidecars.
2. Restore into an isolated test project using the current Supabase recovery guidance for its Auth schema version. Restore Auth users/identities before application rows so profile/customer foreign keys resolve; inspect Auth triggers before importing to avoid duplicate profile provisioning. Never restore over production during a drill.
3. Confirm users can authenticate or are re-invited safely, profile roles/active flags are correct, customer and collector assignments match, and collection totals/reversals/audit records reconcile against the backup.
4. Record restore duration, data cutoff and any manual Auth steps. Repeat after schema changes and at least quarterly.

This repository does not claim zero data loss, a completed restore drill, a configured AWS bucket, or an active scheduled backup. Supabase paid-plan backup/PITR and the external workflow are separate controls.

## Deploy and Install

Build with `npm run build`; deploy the generated `dist/` directory to a static host with HTTPS and SPA fallback to `index.html`. Set the two `VITE_*` values in the host's build environment. Deploy the SQL migration and Edge Function separately. Validate RLS against the deployed project before real customer data is entered. The PWA can be installed from supported Android browsers over HTTPS; laptops can use the browser directly.

## Checks

- `npm test` runs money parsing/formatting, IST conversion and CSV formula-injection tests.
- `npm run lint` runs Oxlint.
- `npm run build` runs TypeScript project checks and generates the production PWA assets.
- `supabase test db` runs the PostgreSQL authorization test file against a local Supabase stack.

All application totals are computed from integer paise; do not introduce floating-point financial arithmetic.
