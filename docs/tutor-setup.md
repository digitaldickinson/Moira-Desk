# Setting up tutor access

Tutors sign in at [the tutor desk](https://digitaldickinson.github.io/Moira-Desk/tutor.html). They can view assigned newsrooms, open the EP wall, leave EP notes, generate reports and retrieve a separate student join code. They cannot create or delete newsrooms, reset conferences or producers, change codes, or manage Cuez destinations.

## One-time database update

In your project's Supabase SQL Editor, run the complete contents of [20261021_tutor_access.sql](../supabase/migrations/20261021_tutor_access.sql). This upgrades an existing Moira:Desk database and can be rerun. It preserves current newsroom codes, memberships and stories. New installations can use the updated full schema instead.

The migration must finish successfully before tutor sign-in works. Publishing the website alone does not apply it.

## Add a colleague

1. Create an email/password account for the colleague in Supabase Authentication and ensure the email is confirmed. An existing confirmed staff account also works. Share any initial password privately; never put passwords in the repository or HTML files.
2. Open your updated local `admin.html` and sign in as an administrator.
3. Under **Tutor access**, choose **Assign a tutor**, enter their account email and tick the newsrooms they should see. Choose **Save access**. Do not add tutors to the `admins` table: that grants full administration access.
4. For each newsroom that needs a reminder code, choose **Tutor code**, then **Enable tutor code**.
5. Share the tutor desk link with your colleague. They sign in with their own email and password.

The local admin file remains private and is not part of the published website. Tutors do not need a copy of it.

## Change access or codes

- **Edit access** changes a tutor's newsroom assignments. **Remove tutor** removes their staff permissions. The database checks these permissions on every request; the open EP wall clears its content if its next refresh is refused.
- **Tutor code** lets you replace or disable the second join code. The main code stays unchanged. Students who have already joined remain members.
- Changing the **main newsroom code** also disables the tutor code. Enable a fresh tutor code afterwards if needed. Use the existing member-removal option when you also need to remove students who have already joined.
- Removing a tutor does not revoke student access they gained using a shared join code or erase reports they have downloaded. If needed, rotate the main code and remove existing memberships, then distribute the new codes to the group.

The original main code remains stored as a hash. The separate tutor code is stored in a restricted table so authorised staff can retrieve it. Anonymous visitors and students cannot retrieve it, including students who belong to the newsroom.

## Checks for maintainers

`node --test tests/sign-out.test.cjs` checks student sign-out behaviour. The tutor permission test uses PGlite (PostgreSQL in WASM); install it outside the project and set `MOIRA_PGLITE_MODULE` to its `dist/index.js`, then run `node tests/tutor-permissions.test.mjs`. Set `MOIRA_BASELINE_SCHEMA` to a previous schema file to check the upgrade path instead of a fresh installation. Browser checks similarly use an external Playwright installation via `MOIRA_PLAYWRIGHT_MODULE` and run `node tests/tutor-ui.test.cjs`. These tools are only for testing; the desk requires no build step.
