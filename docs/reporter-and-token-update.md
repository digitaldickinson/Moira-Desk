# Reporter assignment and Cuez expiry update

For an existing installation:

1. Apply `supabase/migrations/20261023_pitch_reporters.sql` to the project's database. It is safe to rerun. Existing reporter assignments are unchanged; new picks default to the pitch author's name. New installations can use the updated `supabase-schema.sql` instead.
2. Redeploy `send-to-cuez` using its self-contained `index.ts`. For a linked Supabase CLI project, run `supabase functions deploy send-to-cuez` from this folder.
3. Publish the updated `index.html` and replace your local/admin copy of `admin.html`. The Pages workflow deliberately excludes the admin page.

The separate Drop/Rescue fix still requires `supabase/migrations/20261023_drop_pitch_trash.sql` if it has not already been applied.

For deployment through the Supabase dashboard, open **Edge Functions → send-to-cuez → Code** and replace `index.ts` with the complete contents of [supabase/functions/send-to-cuez/index.ts](../supabase/functions/send-to-cuez/index.ts). This is the single source file for both dashboard and CLI deployments and includes the token-status helper. If the function was deleted, create it via the editor and name it exactly `send-to-cuez`. Deploy the function, then sign into the updated local admin page to check the token-expiry indicator. `token-status` is an action within this function, not a separate Edge Function.

The former separate helper and generated dashboard copy have been consolidated into `index.ts`. The behaviour is unchanged, so an installation already running the combined version does not need redeployment just for this consolidation. Use `index.ts` for future updates; no extra local files are required.

The admin header shows Cuez token expiry after sign-in. It refreshes once a minute while visible, on returning to the tab, and when clicked. More than three days is green; three days or fewer is amber; 24 hours or fewer, expired, missing, or not-yet-valid tokens are red. An unreadable expiry or failed check is amber.

Only admins can call `token-status`. The browser receives status and timestamps, never the token. This reads the stored token's expiry; it does not test whether Cuez has revoked it or changed its permissions. It does not renew the token or send scheduled notifications while the admin page is closed. The Cuez write/repair logic is unchanged.

Validation uses local PostgreSQL (PGlite), Node tests, and browser tests with mocked service calls. No production migration, deployment, or Cuez request is performed by these tests.
