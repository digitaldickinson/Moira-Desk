# Reporter assignment and Cuez expiry update

For an existing installation:

1. Apply `supabase/migrations/20261023_pitch_reporters.sql` to the project's database. It is safe to rerun. Existing reporter assignments are unchanged; new picks default to the pitch author's name. New installations can use the updated `supabase-schema.sql` instead.
2. Redeploy `send-to-cuez`, including its new `token-status.ts` module. For a linked Supabase CLI project, run `supabase functions deploy send-to-cuez` from this folder.
3. Publish the updated `index.html` and replace your local/admin copy of `admin.html`. The Pages workflow deliberately excludes the admin page.

The separate Drop/Rescue fix still requires `supabase/migrations/20261023_drop_pitch_trash.sql` if it has not already been applied.

For deployment through the Supabase dashboard, open **Edge Functions → send-to-cuez → Code** and replace `index.ts` with the complete contents of [send-to-cuez-dashboard.ts](send-to-cuez-dashboard.ts). This single-file copy includes the token-status helper. If the function was deleted, create it via the editor and name it exactly `send-to-cuez`. Deploy the function, then sign into the updated local admin page to check the token-expiry indicator. `token-status` is an action within this function, not a separate Edge Function.

The dashboard copy is generated from `supabase/functions/send-to-cuez/index.ts` by replacing its `./token-status.ts` import with that helper file's contents. Regenerate it whenever either source file changes.

The admin header shows Cuez token expiry after sign-in. It refreshes once a minute while visible, on returning to the tab, and when clicked. More than three days is green; three days or fewer is amber; 24 hours or fewer, expired, missing, or not-yet-valid tokens are red. An unreadable expiry or failed check is amber.

Only admins can call `token-status`. The browser receives status and timestamps, never the token. This reads the stored token's expiry; it does not test whether Cuez has revoked it or changed its permissions. It does not renew the token or send scheduled notifications while the admin page is closed. The Cuez write/repair logic is unchanged.

Validation uses local PostgreSQL (PGlite), Node tests, and browser tests with mocked service calls. No production migration, deployment, or Cuez request is performed by these tests.
