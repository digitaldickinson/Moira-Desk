# Moira:Desk

The editorial desk for a Cuez newsroom. Journalists write, check and order the bulletin in Moira:Desk, then send it to [Cuez Rundown](https://cuez.live), which handles production and playout.

It's a trimmed sibling of [Moira:Rundown](https://github.com/digitaldickinson/moira-rundown): still one `index.html` with no build step, backed by Supabase.

## GitHub Pages

The student desk is published at **https://digitaldickinson.github.io/Moira-Desk/** once Pages is enabled.

In the repository's **Settings → Pages → Build and deployment**, choose **GitHub Actions** as the source. Then run **Deploy desk to GitHub Pages** from the Actions tab (or push a change to `main`). The workflow copies only `index.html` into the website artifact; the database schema, Edge Function source and documentation are not served as website files. No local build tools are needed.

The Supabase project URL and browser `anon` key in `index.html` are public configuration. The database's membership checks and Row Level Security protect newsroom data. Never put a Supabase service-role/secret key, Cuez bearer token, admin password or Turnstile secret in the page or repository. The Edge Function reads its credentials from Supabase secrets.

`admin.html`, `cuez-test.html`, `cuez-capture.js` and environment files are local-only and excluded from this public repository. Keep your existing local admin page for administration; it is not included in a fresh clone. The deployment deliberately uses an explicit file list rather than publishing the repository root. If the desk gains local assets later, add only those public assets to the workflow.

If Turnstile is enabled, allow `digitaldickinson.github.io` in its widget settings. Publishing this site does not deploy the Supabase schema or Edge Function; follow Setup below for those.

```
index.html                                  the desk, for students (your Supabase details go at the top)
admin.html                                  your admin page: run it from your laptop, don't publish it
supabase-schema.sql                         tables, members-only rules, join codes, admin functions
supabase/functions/send-to-cuez/index.ts    Edge Function that writes to Cuez
```

## How access works

- **Each browser signs in anonymously** and gets a hidden user ID. That session is reused on every visit, so a reload doesn't lose anything.
- **On first visit, a student enters their name and a newsroom code.** The code admits that browser to that newsroom, and only that one.
- **The database's Row Level Security only lets a browser see newsrooms it has joined.** Without a code there's nothing to read, so the project URL and anon key are safe to publish in the page.
- **Members can't write story rows or the running order directly.** Every change goes through a database function that checks membership, and the server keeps its own safeguards:
  - **Revisions** are set by the server.
  - **Locks** are tied to the signed-in browser and timed by the database clock. Only the holder can renew or release a lock, and a save is refused while someone else holds a live one.
  - **Cuez send state** is written only by the send function. Members can only clear it ("mark as not sent").
  - **Undo delete** restores the server's own copy of the story, not what the browser sends back.

  A modified page can do no more than the real one. Members can still change the newsroom's formats list and target duration directly. Those are settings, not safeguards.
- **Only admins create newsrooms, set codes and choose Cuez targets**, using `admin.html` or the SQL Editor. Students see their newsroom's Cuez target but can't change it, and nothing they can reach creates, lists or reads codes. Codes are stored only as hashes.
- **The admin page holds no secrets.** You sign in with an email and password, and the database only accepts admin actions from accounts listed in its `admins` table. Your admin session is kept for that browser tab only, and is separate from the anonymous student session.
- **Guessing is limited, in three layers:**
  - **Per browser.** Eight wrong codes in ten minutes locks that browser out.
  - **Overall.** If wrong codes across everyone pass 300 in ten minutes, joining pauses for everyone until the window clears. That stops someone dodging the per-browser limit with fresh anonymous identities. A class making typos won't get near it, and people already in a newsroom aren't affected. The trade-off is that a determined attacker could pause joining for a while.
  - **New identities.** Supabase's anonymous sign-in limit applies, plus Turnstile if you turn it on (see Setup).

  The checks run under a database lock, so simultaneous guesses can't slip past them. Generated codes are 8 characters from 31 letters and numbers, far beyond reach of these rates. Memorable custom codes such as `RED-2026` are the weak point, so prefer generated ones.
- **Changing a newsroom's code removes everyone who joined with the old one.** Open pages notice within a minute.
- **The send function checks membership itself before touching Cuez.** The Cuez token lives only in the function's secrets.
- **The producer role is enforced by the database.** Only the browser that claimed it can pick or spike pitches, and, once someone has claimed it, send to Cuez.
- **Shared computers:** Settings → Forget signs the browser out and clears everything, codes included.

## Setup

Use the same Supabase project as the proof of concept. It already has the function and the Cuez token.

1. **Add your project details to `index.html`.** Near the top of the script:
   ```js
   const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
   const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
   ```
   Both are under Project Settings → API. If you leave the placeholders in, the page runs in Local Mode, which stays in this browser only.
2. **Run `supabase-schema.sql` in the SQL Editor.** It upgrades the first version in place, removes the old open access, and is safe to re-run.
3. **Check the Authentication settings.**
   - Make sure Anonymous Sign-Ins is on (Authentication → Sign In / Providers).
   - In Authentication → Rate Limits, raise the anonymous sign-in limit. A class behind the campus network shares one address, and the default is per address.
4. **Redeploy the function:**
   ```bash
   npx supabase functions deploy send-to-cuez --use-api
   ```
5. **Optional, recommended: turn on CAPTCHA (Cloudflare Turnstile).** Supabase recommends this for anonymous sign-ins, and it puts a human check in front of new identities.
   - In Cloudflare, create a free Turnstile widget. Add your GitHub Pages hostname, and `localhost` for the admin page.
   - Put the **site key** in `TURNSTILE_SITE_KEY` at the top of both `index.html` and `admin.html`, and publish `index.html`.
   - Then, in Supabase, go to Authentication → Attack Protection, enable CAPTCHA, choose Turnstile, and paste the **secret key**.
   - Do it in that order: once CAPTCHA is on, sign-ins without a token are refused.
   - It's invisible most of the time, and only appears the first time a browser signs in.
   - It also covers your admin password sign-in, which can't run from a `file://` page. Serve the folder instead, e.g. `python3 -m http.server 8080`, then open `http://localhost:8080/admin.html`.
   - When a site key is set, the admin page loads Cloudflare's script as well as the pinned Supabase library. Cloudflare's script can't be pinned with an integrity hash.
6. **Make yourself an admin.**
   - In the dashboard, go to Authentication → Users → Add user → Create new user. Enter your email and a strong password, and tick **Auto Confirm User**, so no confirmation email is needed.
   - Then run this in the SQL Editor:
     ```sql
     insert into admins (user_id, email)
     select id, email from auth.users where email = 'you@mmu.ac.uk';
     ```
   - Leave **Confirm email** switched on under Authentication → Sign In / Providers → Email. Anyone who tries to sign up another email account can then never confirm it, and an unconfirmed account has no access anyway.
7. **Put the same two Supabase values at the top of `admin.html`, and open it from your laptop.** Sign in, create a newsroom, set its Cuez target, and show the class its code.

The proof-of-concept test page is retired: its open send action has gone.

## Admin page

`admin.html` does everything below without SQL:
- **Newsrooms:** create, rename and delete (deleting asks you to type the name).
- **Codes:** a new code with or without removing current members, shown once with **Copy** and **Show full screen** for the projector.
- **Cuez target:** paste the episode address, pick a part, and optionally mark sent stories as not sent.
- **Members:** see member and story counts, and remove all members.
- **Conference:** each newsroom's producer and pitch count, **New conference** and **Clear producer** per newsroom, and, for the newsrooms you tick:
  - **Open EP wall** shows their pitches side by side, live, for projecting. **Note** on a pitch adds your comment for that group. **A−/A+** change the text size, and Esc closes the wall.
  - **Generate report** makes a single web page with each newsroom's conference (every pitch and its outcome, with your notes) and running order (TRT against target, checks, Cuez status), plus scripts if you tick that box. It needs no login, so you can download it and share it by email, Moodle or Teams, or print it to PDF. It's a snapshot of that moment.
  - **New conference for ticked** clears the boards for the next session.

It loads one external script, the Supabase library, pinned to an exact version with an integrity check, so a changed file is refused. Keep it off the public site: it's harmless without your password, but there's no reason to advertise it. The `.gitignore` leaves it out of the repo.

## Admin cheat sheet (SQL Editor)

The same actions are available as SQL, which is handy if you're not at your laptop:

| What | SQL |
| --- | --- |
| New newsroom, generated code | `select * from create_newsroom('Newsday Blue');` |
| New newsroom, your own code | `select * from create_newsroom('Newsday Red', 'RED-2026');` |
| New code, removing current members | `select set_newsroom_code('bulletin-newsday-blue');` |
| New code, keeping current members | `select set_newsroom_code('bulletin-newsday-blue', null, false);` |
| Give the original test room a code and name | `select set_newsroom_code('bulletin-primary', 'MAIN-0001');` then `update bulletins set name = 'Main' where id = 'bulletin-primary';` |
| Set a Cuez target | `select set_cuez_target('bulletin-newsday-blue', '<episode id>', 'Episode title', '<part uid>', 'Part title', true);` |
| See newsrooms, members, Cuez targets | `select * from admin_newsrooms();` |
| Delete a newsroom and its stories | `select delete_newsroom('bulletin-newsday-blue');` |

Codes ignore case, spaces and dashes: `blue 1234` and `BLUE-1234` are the same code. Codes need at least six letters or numbers, and generated ones avoid 0/O and 1/I/L.

## News conference

The **Conference** tab, next to **Running order**, follows the newsroom's morning meeting:

1. **The group gets a newsroom code**, and whoever drew the queen clicks **I'm the producer**. The role belongs to that browser; everyone sees the producer's name, and only the producer can pick stories and send to Cuez.
2. **The producer runs the meeting and types in the pitches**: a slug, the angle in a line, and who pitched it. Press Enter to add and go straight on to the next. Anyone in the group can add pitches too, which is handy during the read-in.
3. **The EP opens the wall** in `admin.html` to discuss every group's list on the projector, and can add a note to any pitch. Notes are advice, shown to the group; they don't pick or spike anything.
4. **The producer decides.** **Pick** adds a pitch to the running order, above END OF PROGRAMME, in the order picked, with its angle shown in the editor as the brief (never sent to Cuez). Once it's picked, the producer chooses its **format** on the card (how it'll be covered), which sets the story's format in the running order. **Spike** drops it, with an optional reason that's kept for the record. **Drop** takes a picked story out of the running order again and returns it to the pitches, but only while nobody has written it or has it open.
5. **Then it's the usual flow:** write, check, order, and the producer sends to Cuez.

Other details:
- **Handing over:** the producer clicks **Step down** and the new one claims the role. If the producer's laptop dies, use **Clear producer** in admin.
- **Removed members lose the role.** If you change the code (removing members) or use **Remove members**, a producer who was removed stops being producer, so the group can claim it again without you.
- **Producer-only sending:** this applies once someone has claimed producer. A newsroom that doesn't use conference sends as before.
- **New conferences:** start one per session from admin. It clears the board and frees the role. Earlier pitches stay in the database as a read-only record, but they drop out of the board and the report, so generate the report first.

## Writing for Cuez

The **+ Clip**, **+ Strap** and **+ Direction** buttons above the script insert these tags at the cursor, with the first placeholder selected ready to type over. Untouched placeholders ("Clip title", "Job title" and so on) are ignored.

| In the script | In Cuez |
| --- | --- |
| Plain text | a **PROMPTER** block (one paragraph per line) |
| `[CLIP]` | an empty **CLIP** block called "SLUG CLIP" |
| `[CLIP:1:20 Council VT]` | a clip titled "Council VT", duration 1:20 |
| `[CLIP:1:20 Council VT \| SOT \| LW: ...nothing left]` | the same, with Sound set to SOT and the Last Words filled in |
| `[STRAP: Andy Dickinson \| Senior Lecturer]` | a **LOWER THIRD** with name and description |
| `[CAM 2]`, `[CUE: STANDBY VT]`, any other `[direction]` | an **INSTRUCTIONS** block (red, not read out); directions next to each other share one block |

Parts of a clip tag can go in any order after the title. Blocks follow the script's order, so text, `[CLIP…]`, text becomes prompter, clip, prompter.

- **Sound.** A clip without SOT or OFF gets OFF in OOV and ULAY stories, and SOT in all others.
- **Clip formats.** A story in WRAP, CLIP, OOV, ULAY, OOV/CLIP, ULAY/CLIP, PKG or VT gets one empty clip block after the script if it has no `[CLIP]` tag.
- **Older templates.** If an episode's template has no INSTRUCTIONS or LOWER THIRD block, those tags stay in the prompter text instead.
- **Timing.** The estimate uses the read speed of the newsroom's Cuez template (120 wpm by default) plus clip durations. **Use estimate** copies it into Duration. Cuez also times INSTRUCTIONS text, so its total can run slightly longer for direction-heavy stories.
- **The "In Cuez" strip** under the script shows the blocks the story will become, in Cuez's colours, as you type.
- **Item numbers.** Once sent, a story shows its Cuez item number ("Item 4"). Cuez renumbers when items are added above, so numbers are refreshed on every send and are "as of the last send".

## How sending works

- **What goes.** Everything above END OF PROGRAMME that isn't floated, isn't a segment and hasn't been sent.
- **Who sends.** The producer, once one has claimed the role; otherwise any member.
- **One send per newsroom at a time.**
- **Placement follows Moira's running order.** Each new story goes after its nearest earlier neighbour already in Cuez.
- **"Sent" means the whole story arrived.** After writing, the function reads the episode back and checks every story: the item is in the part, each of its blocks is attached to it, and each field holds what was written (compared as text, since Cuez may re-save the prompter's markup).
  - **Incomplete stories aren't marked as sent.** An item that arrived with a block or script missing stays **Unconfirmed**, and the next send repairs it in place. It's the same item: missing blocks are attached and content rewritten, with nothing duplicated.
  - **Rejected operations count against their story.** Cuez answers 200 even when it rejects an operation, so each rejection is matched to its story. The only ones ignored are a retry's duplicate attaches, and only when the read-back shows the original really is attached. A rejected script or content write always counts.
  - **Block order is a warning, not a failure.** A retry can add a missing block but can't reorder attached ones, so a story with blocks in the wrong order is marked as sent and named in the message for checking in Cuez.
  - **Checked against a real episode.** The way Cuez returns block content was confirmed from a captured episode. Verification passes complete stories and flags altered content and missing blocks. If Cuez ever changes that format, the send message says content wasn't checked rather than passing it silently.
  - **Still unconfirmed:** whether Cuez refuses a duplicate block attach. The second half of `cuez-capture.js` tests it, and needs your session to write one test item.
- **Retries reuse the original send.** Before writing, the function records each story's Cuez item ID and exactly what it is about to send. Every other ID in that send (blocks, contexts) is derived from the item ID. If a send can't confirm (Cuez is slow, the connection drops, the function stops part-way), the story shows **Unconfirmed**. The next send checks Cuez first: if the item is there, it's marked as sent. If not, the same send is repeated with the same IDs and the same content. A new identity is never issued, however long it has been.
- **Why that matters.** Cuez can return an out-of-date read, or the first write can arrive late. Either way the retry and the original target the same item, so Cuez refuses the second attach (`PART_ITEM_ADDED`) instead of adding a copy. Tested against a fake Cuez for out-of-date reads, late writes and collisions between the two.
- **What it depends on.** Cuez refusing a duplicate item attach has been seen on the real system. Refusing a duplicate block attach (`ITEM_BLOCK_INSTANCE_ADDED`) is assumed, not yet confirmed. If Cuez accepted that one, a late collision could double the blocks inside one item, but never the item itself. One known side-effect: a retry re-writes the original content, so in that rare collision it can overwrite edits a producer made in Cuez in the meantime.
- **Unconfirmed after an edit.** A retry sends the version that was originally sent, not the latest edit, so the story then shows **Changed**.
- **Older unconfirmed sends.** These were recorded before this change, without their content, so they're held back rather than guessed at. Check Cuez, then click the badge to clear it.
- **Send once.** Editing a sent story shows **Changed**. To resend, click the badge to mark it as not sent; that adds a second copy, so delete the old one in Cuez first.
- **Moira-only changes.** Deleting or reordering in Moira doesn't change Cuez.

## Editing and locks

- **Saves are confirmed before the editor closes.** If a save fails, the editor stays open with your text and an error, so you can try again. Nothing in the rundown changes until the save succeeds.
- **Reordering happens in the database in one step**, so two people moving and adding stories at once can't lose each other's changes.
- **One editor per story.** Opening a story locks it, and others see who has it.
- **Switching tabs keeps the editor open**, for example to check Cuez. Your lock is renewed when you come back.
- **Your own lock from another tab** (or a page you reloaded mid-edit) can be taken straight away with **Edit here**.
- **Someone else's lock** can be taken over 45 seconds after their tab goes quiet. The database decides this, using its own clock. If your lock was taken while your tab was idle, you're warned and your text stays put, but saving is refused while they're still editing, so copy your text somewhere safe.
- **If two people save the same story**, the second is asked which version to keep.

## Limits

- **A code is a shared secret.** Anyone who has it can join, so change it for each newsday or cohort.
- **Names are typed, not verified.** Fine for running a newsroom, not for assessment evidence. Microsoft sign-in through MMU (via IT) would add verified identities on top of codes. The same goes for "pitched by" and the producer's name.
- **One Cuez account.** Every Cuez item is created as the owner of the Cuez token.
- **Weekly token refresh.** The Cuez token lasts about a week. When sends fail with "Cuez rejected the token", set a fresh `CUEZ_BEARER_TOKEN`.
- **Undocumented API.** This uses Cuez's internal API, which can change without notice.
