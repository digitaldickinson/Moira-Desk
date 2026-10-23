# Personal admin newsroom folders

Folders organise only the newsroom list in the local `admin.html`. Each admin has their own folders and assignments, saved in Supabase and available from any computer when they sign in with the same account. Student and tutor views, join codes, newsroom contents and access permissions are unchanged.

## Enable the update

1. In the Supabase project's SQL Editor, run the complete contents of [20261023_admin_folders.sql](../supabase/migrations/20261023_admin_folders.sql). It is safe to rerun. New installations can use the updated `supabase-schema.sql` instead.
2. Open the updated local `admin.html`, sign in and click **Refresh**. No Edge Function redeployment is required.

If folders cannot be loaded, the admin page shows the normal newsroom list and disables folder editing until a refresh succeeds.

## Organise classes

- Choose **New folder**, for example `Year 2 · Autumn 2026` or `Previous classes`.
- Use **Move to folder** on a newsroom, or tick several and choose **Move selected**. Choose **Unfiled** to remove a grouping.
- Click a folder heading to open or collapse it. Counts show how many newsrooms it contains and how many are selected. Open/closed preferences are remembered separately in each browser.
- **Find a newsroom** searches across every folder, including collapsed ones. Clearing the search restores the collapsed view. The checkbox in each table selects only the rooms currently shown in that table; selected rooms remain selected when a folder is collapsed or a search is changed. Use **Clear selection** to clear them all.
- **Rename** changes a folder's name. **Remove folder** returns its newsrooms to Unfiled without deleting their contents.

Folder grouping is personal organisation, not archiving: rooms continue to work normally while their folder is collapsed. Other admins organise the same rooms independently.

## Checks

`tests/admin-folders.test.mjs` covers database permissions, isolation between admins, validation, bulk moves, deleting folders without changing newsroom data, deleted-room cleanup, and repeatable migrations. Set `MOIRA_PGLITE_MODULE` to an external PGlite installation's `dist/index.js`; optionally set `MOIRA_BASELINE_SCHEMA` to an older schema to check the upgrade path.

`tests/admin-folders-ui.test.cjs` checks creation, renaming, moving, collapsed views, search, selection, error recovery and mobile layout using mocked service calls. Set `MOIRA_PLAYWRIGHT_MODULE` and, if needed, `PLAYWRIGHT_BROWSERS_PATH` to external test installations. It skips when the local-only admin file is absent.
