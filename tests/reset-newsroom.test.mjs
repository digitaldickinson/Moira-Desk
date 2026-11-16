// Admin resets: clear_running_order and reset_newsroom.
// Run with a temporary PGlite installation via MOIRA_PGLITE_MODULE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.MOIRA_PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const schema = await readFile(new URL('../supabase-schema.sql', import.meta.url), 'utf8');
const migrations = await Promise.all(['20261116_reset_newsroom.sql', '20261116_tutor_reset_newsroom.sql']
    .map((f) => readFile(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8')));
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, is_anonymous boolean);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;
  grant usage on schema auth, public to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  create publication supabase_realtime;
`);
const baseline = process.env.MOIRA_BASELINE_SCHEMA
    ? await readFile(process.env.MOIRA_BASELINE_SCHEMA, 'utf8') : schema;
await db.exec(baseline.replace('create extension if not exists pgcrypto;', ''));
for (const m of migrations) { await db.exec(m); await db.exec(m); }

const admin = '00000000-0000-0000-0000-000000000001';
const student = '00000000-0000-0000-0000-000000000002';
const tutor = '00000000-0000-0000-0000-000000000003';
await db.exec(`insert into auth.users values
 ('${admin}', 'admin@example.test', now(), false),
 ('${student}', null, null, true), ('${tutor}', 'tutor@example.test', now(), false);
 insert into admins(user_id) values ('${admin}');`);
async function asUser(id) {
    await db.exec('set session authorization postgres');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    await db.exec('set session authorization authenticated');
}
async function value(sql, params = []) { return Object.values((await db.query(sql, params)).rows[0])[0]; }
async function asOwner(sql, params = []) { await db.exec('set session authorization postgres'); const r = await db.query(sql, params); return r.rows; }

await asUser(admin);
const room = (await db.query("select * from create_newsroom('Reset test', 'RESETA123')")).rows[0].newsroom_id;
const other = (await db.query("select * from create_newsroom('Other room', 'OTHERB123')")).rows[0].newsroom_id;
await db.query("select set_tutor_access('tutor@example.test', array[$1])", [room]);

async function seedRoom() {
    await asUser(student);
    await db.query("select * from join_newsroom('RESETA123')");
    await db.query("select claim_producer($1, 'Producer')", [room]);
    const kept = await value("select add_pitch($1, 'Council', 'Angle', '', 'Sam')", [room]);
    const picked = await value("select add_pitch($1, 'Bins', 'Angle', '', 'Jo')", [room]);
    const story = await value('select pick_pitch($1)', [picked]);
    await db.query("select save_story($1, '{\"script\":\"Words\"}'::jsonb, 1)", [story]);
    const gone = await value("select add_pitch($1, 'Fete', '', '', 'Al')", [room]);
    const goneStory = await value('select pick_pitch($1)', [gone]);
    await db.query('select delete_story($1, $2)', [room, goneStory]);
    await db.query('select spike_pitch($1, $2)', [kept, 'Too soft']);
    return { kept, picked, story };
}
const seeded = await seedRoom();
await asUser(admin);
await db.query("select tutor_send_alert(array[$1], 'Back at 2')", [room]);

// Students and tutors can't reset anything.
for (const who of [student, tutor]) {
    await asUser(who);
    await assert.rejects(db.query('select clear_running_order($1)', [room]), /admin/i);
    await assert.rejects(db.query('select reset_newsroom($1)', [room]), /admin/i);
}
await asUser(student);
await assert.rejects(db.query('select tutor_reset_newsroom($1)', [room]), /Staff access/);
await assert.rejects(db.query('select reset_newsroom_now($1)', [room]), /permission denied/);
await asUser(tutor);
await assert.rejects(db.query('select tutor_reset_newsroom($1)', [other]), /Newsroom unavailable/, 'unassigned newsroom');
await assert.rejects(db.query("select tutor_reset_newsroom('bulletin-nope')"), /Newsroom unavailable/);
await assert.rejects(db.query('select reset_newsroom_now($1)', [room]), /permission denied/);
await asUser(admin);
await assert.rejects(db.query("select clear_running_order('bulletin-nope')"), /No newsroom/);

// A Cuez send in progress blocks the clear; a stale claim doesn't.
await asOwner("update bulletins set cuez_sending_at = now() where id = $1", [room]);
await asUser(admin);
await assert.rejects(db.query('select clear_running_order($1)', [room]), /Cuez send is in progress/);
await asOwner("update bulletins set cuez_sending_at = now() - interval '10 minutes' where id = $1", [room]);
console.log('PASS: only admins can reset, and not mid-send');

// Clear the running order: stories counted (the starter story plus one pick), Undo copies gone.
await asUser(admin);
const before = await asOwner('select conference_id, producer_name from bulletins where id = $1', [room]);
await asUser(admin);
assert.equal(await value('select clear_running_order($1)', [room]), 2);
let [b] = await asOwner('select order_ids, conference_id, producer_name, ep_alert_text from bulletins where id = $1', [room]);
assert.deepEqual(b.order_ids, ['marker-line']);
assert.equal(b.conference_id, before[0].conference_id, 'conference untouched');
assert.equal(b.producer_name, 'Producer', 'producer untouched');
assert.equal(b.ep_alert_text, 'Back at 2', 'alert untouched');
assert.equal((await asOwner('select count(*)::int n from stories where bulletin_id = $1', [room]))[0].n, 0);
assert.equal((await asOwner('select count(*)::int n from deleted_stories where bulletin_id = $1', [room]))[0].n, 0);
const pitches = Object.fromEntries((await asOwner('select id, status, story_id, spike_reason from pitches where bulletin_id = $1', [room])).map((p) => [p.id, p]));
assert.equal(pitches[seeded.picked].status, 'pitched', 'picked pitch returns to the board');
assert.equal(pitches[seeded.picked].story_id, null);
assert.equal(pitches[seeded.kept].status, 'spiked', 'spiked pitch stays spiked');
assert.equal((await asOwner('select count(*)::int n from stories where bulletin_id = $1', [other]))[0].n, 1, 'other newsroom untouched');
assert.equal((await asOwner('select count(*)::int n from newsroom_members where bulletin_id = $1', [room]))[0].n, 1, 'members untouched');

// The students can carry on: a new story and a re-pick go above END OF PROGRAMME.
await asUser(student);
const again = await value('select pick_pitch($1)', [seeded.picked]);
[b] = await asOwner('select order_ids from bulletins where id = $1', [room]);
assert.deepEqual(b.order_ids, [again, 'marker-line']);
await asUser(student);
await assert.rejects(db.query('select restore_story($1, $2, 0)', [room, seeded.story]));
console.log('PASS: clear_running_order empties the rundown and returns picks to the board');

// Reset everything.
await asUser(admin);
await db.query('select reset_newsroom($1)', [room]);
[b] = await asOwner(`select order_ids, conference_id, producer_name, producer_user, ep_alert_text, ep_alert_at, name, cuez_part_uid
                     from bulletins where id = $1`, [room]);
assert.deepEqual(b.order_ids, ['marker-line']);
assert.notEqual(b.conference_id, before[0].conference_id, 'new conference');
assert.equal(b.producer_name, null); assert.equal(b.producer_user, null);
assert.equal(b.ep_alert_text, null); assert.equal(b.ep_alert_at, null);
assert.equal(b.name, 'Reset test');
assert.equal((await asOwner('select count(*)::int n from stories where bulletin_id = $1', [room]))[0].n, 0);
assert.equal((await asOwner('select count(*)::int n from newsroom_members where bulletin_id = $1', [room]))[0].n, 0);
assert.equal((await asOwner('select count(*)::int n from newsroom_codes where bulletin_id = $1', [room]))[0].n, 1, 'code kept');
assert.equal((await asOwner('select count(*)::int n from tutor_newsroom_access where bulletin_id = $1', [room]))[0].n, 1, 'tutor access kept');
assert.equal((await asOwner('select count(*)::int n from pitches where bulletin_id = $1', [room]))[0].n, 3, 'earlier pitches kept for the record');
await asUser(admin);
const conf = (await db.query('select admin_conference(array[$1]) as c', [room])).rows[0].c;
assert.equal(JSON.stringify(conf).includes('Council'), false, 'old pitches off the board');

// A new group can join with the same code and start afresh.
await asUser(student);
await db.query("select * from join_newsroom('RESETA123')");
await db.query("select claim_producer($1, 'New producer')", [room]);
console.log('PASS: reset_newsroom readies the newsroom for a new group');

// A tutor resets their assigned newsroom the same way.
await seedRoom();
await asUser(tutor);
await db.query("select tutor_send_alert(array[$1], 'Back at 3')", [room]);
await asOwner("update bulletins set cuez_sending_at = now() where id = $1", [room]);
await asUser(tutor);
await assert.rejects(db.query('select tutor_reset_newsroom($1)', [room]), /Cuez send is in progress/);
await asOwner("update bulletins set cuez_sending_at = null where id = $1", [room]);
const [prev] = await asOwner('select conference_id from bulletins where id = $1', [room]);
await asUser(tutor);
await db.query('select tutor_reset_newsroom($1)', [room]);
[b] = await asOwner('select order_ids, conference_id, producer_name, ep_alert_text from bulletins where id = $1', [room]);
assert.deepEqual(b.order_ids, ['marker-line']);
assert.notEqual(b.conference_id, prev.conference_id);
assert.equal(b.producer_name, null); assert.equal(b.ep_alert_text, null);
assert.equal((await asOwner('select count(*)::int n from stories where bulletin_id = $1', [room]))[0].n, 0);
assert.equal((await asOwner('select count(*)::int n from newsroom_members where bulletin_id = $1', [room]))[0].n, 0);
assert.equal((await asOwner('select count(*)::int n from stories where bulletin_id = $1', [other]))[0].n, 1, 'other newsroom untouched');
console.log('PASS: tutors can reset only their assigned newsrooms');
