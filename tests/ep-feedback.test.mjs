// Run with MOIRA_PGLITE_MODULE pointing to an external PGlite installation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.MOIRA_PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
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
const schema = await readFile(new URL('../supabase-schema.sql', import.meta.url), 'utf8');
const baseline = process.env.MOIRA_BASELINE_SCHEMA ? await readFile(process.env.MOIRA_BASELINE_SCHEMA, 'utf8') : schema;
await db.exec(baseline.replace('create extension if not exists pgcrypto;', ''));
const migration = await readFile(new URL('../supabase/migrations/20261102_ep_feedback.sql', import.meta.url), 'utf8');
await db.exec(migration); await db.exec(migration);

const admin = '00000000-0000-0000-0000-000000000001';
const tutor = '00000000-0000-0000-0000-000000000002';
const studentA = '00000000-0000-0000-0000-000000000003';
const studentB = '00000000-0000-0000-0000-000000000004';
const storyA = '10000000-0000-0000-0000-000000000001';
const storyB = '10000000-0000-0000-0000-000000000002';
await db.exec(`insert into auth.users(id,email,email_confirmed_at,is_anonymous) values
 ('${admin}', 'admin@example.test', now(), false), ('${tutor}', 'tutor@example.test', now(), false),
 ('${studentA}', null, null, true), ('${studentB}', null, null, true);
 insert into admins(user_id) values ('${admin}');`);
async function asUser(id, role = 'authenticated') {
 await db.exec('set session authorization postgres');
 await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id || '']);
 await db.exec(`set session authorization ${role}`);
}
const save = (id, room, story, quote, body) => db.query('select tutor_save_feedback($1,$2,$3,$4,$5) as id', [id, room, story, quote, body]).then(r => r.rows[0].id);
const remove = (id) => db.query('select tutor_delete_feedback($1)', [id]);
const snapshot = async (room) => (await db.query('select tutor_conference($1, true) as d', [[room]])).rows[0].d[0].feedback;

await asUser(admin);
const a = (await db.query("select * from create_newsroom('Feedback A', 'FEEDA123')")).rows[0].newsroom_id;
const b = (await db.query("select * from create_newsroom('Feedback B', 'FEEDB123')")).rows[0].newsroom_id;
await db.query('select set_tutor_access($1,$2)', ['tutor@example.test', [a]]);
await asUser(studentA); await db.query("select * from join_newsroom('FEEDA123')");
await db.query('select create_story($1,$2,$3)', [a, storyA, { slug: 'Bridge', script: 'The council say the bridge shuts tonight.' }]);
await asUser(studentB); await db.query("select * from join_newsroom('FEEDB123')");
await db.query('select create_story($1,$2,$3)', [b, storyB, { slug: 'Other room' }]);

// Tutors write overall and story feedback for their own newsrooms only.
await asUser(tutor);
const overall = await save(null, a, null, 'ignored quote', '  Good pace, but the lead was buried.  ');
const onStory = await save(null, a, storyA, ' The council say ', 'Who at the council? Attribute it.');
let fb = await snapshot(a);
assert.deepEqual(fb.map(f => [f.story_id, f.story_slug, f.quote, f.body]), [
 [null, null, null, 'Good pace, but the lead was buried.'],
 [storyA, 'Bridge', 'The council say', 'Who at the council? Attribute it.'],
]);
await assert.rejects(() => save(null, b, null, null, 'Not my room'), /Newsroom unavailable/);
await assert.rejects(() => save(null, a, storyB, null, 'Story from another room'), /no longer in this running order/);
for (const body of ['', '   ', null]) await assert.rejects(() => save(null, a, null, null, body), /Write some feedback/);
const long = await save(null, a, storyA, 'q'.repeat(600), 'x'.repeat(2100));
fb = await snapshot(a);
assert.equal(fb.at(-1).body.length, 2000); assert.equal(fb.at(-1).quote.length, 500);

// Any staff member can edit or delete any comment; overall feedback never gains a quote.
await asUser(admin);
const adminNote = await save(null, a, null, null, 'From the admin');
await asUser(tutor);
await save(adminNote, null, null, 'quote', 'Edited by the tutor');
await save(onStory, null, null, '', 'Attribute the council line.');
await remove(long);
fb = await snapshot(a);
assert.deepEqual(fb.map(f => [f.quote, f.body]), [[null, 'Good pace, but the lead was buried.'], [null, 'Attribute the council line.'], [null, 'Edited by the tutor']]);
await assert.rejects(() => save(adminNote, null, null, null, '  '), /Write some feedback/);

// Students read their own newsroom's feedback and cannot write it.
await asUser(studentA);
assert.equal((await db.query('select count(*)::int as n from ep_feedback')).rows[0].n, 3);
await assert.rejects(() => save(null, a, null, null, 'Student spoof'), /Staff access/);
await assert.rejects(() => remove(overall), /Staff access/);
await assert.rejects(() => db.query('update ep_feedback set body = $1', ['Spoof']));
await assert.rejects(() => db.query('delete from ep_feedback'));
await assert.rejects(() => db.query('insert into ep_feedback (bulletin_id, conference_id, body) values ($1, gen_random_uuid(), $2)', [a, 'Spoof']));
await assert.rejects(() => db.query('select tutor_conference($1, true)', [[a]]));
await asUser(studentB);
assert.equal((await db.query('select count(*)::int as n from ep_feedback')).rows[0].n, 0, 'other newsrooms cannot see it');
await asUser(null, 'anon');
await assert.rejects(() => db.query('select count(*) from ep_feedback'));

// A deleted story keeps its feedback (and its slug) so an undo restores both.
await asUser(studentA); await db.query('select delete_story($1,$2)', [a, storyA]);
await asUser(tutor);
fb = await snapshot(a);
assert.equal(fb.find(f => f.id === onStory).story_slug, 'Bridge');
await assert.rejects(() => save(null, a, storyA, null, 'Too late'), /no longer in this running order/);
await asUser(studentA); await db.query('select restore_story($1,$2,$3)', [a, storyA, 0]);

// Revoked access and a new conference both close the door.
await asUser(admin); await db.query('select set_tutor_access($1,$2)', ['tutor@example.test', [b]]);
await asUser(tutor);
await assert.rejects(() => save(overall, null, null, null, 'Revoked'), /Feedback unavailable/);
await assert.rejects(() => remove(overall), /Feedback unavailable/);
await asUser(admin); await db.query('select set_tutor_access($1,$2)', ['tutor@example.test', [a, b]]);
await db.query('select start_conference($1)', [a]);
assert.deepEqual(await snapshot(a), [], 'a new conference starts with no feedback');
await asUser(tutor);
await assert.rejects(() => save(overall, null, null, null, 'Old'), /earlier conference/);
await assert.rejects(() => remove(overall), /earlier conference/);
await save(null, a, storyA, null, 'Fresh session');
assert.equal((await snapshot(a)).length, 1);

await asUser(admin, 'postgres'); await db.exec(schema.replace('create extension if not exists pgcrypto;', ''));
await db.exec(migration);
console.log('PASS: staff-only feedback for assigned newsrooms, any staff edit/delete, quotes on stories only, length limits, student read-only and newsroom-scoped, deleted stories keep feedback, revoked access, conference scoping and repeatable migration/schema');
await db.close();
