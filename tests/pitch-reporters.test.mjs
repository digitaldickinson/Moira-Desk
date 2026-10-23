// Run with a temporary PGlite installation via MOIRA_PGLITE_MODULE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.MOIRA_PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const schema = await readFile(new URL('../supabase-schema.sql', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261023_pitch_reporters.sql', import.meta.url), 'utf8');
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
await db.exec(migration);
await db.exec(migration);
const admin = '00000000-0000-0000-0000-000000000001';
const student = '00000000-0000-0000-0000-000000000002';
const reporter = '00000000-0000-0000-0000-000000000003';
await db.exec(`insert into auth.users values
 ('${admin}', 'admin@example.test', now(), false),
 ('${student}', null, null, true), ('${reporter}', null, null, true);
 insert into admins(user_id) values ('${admin}');`);
async function asUser(id) {
    await db.exec('set session authorization postgres');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    await db.exec('set session authorization authenticated');
}
async function value(sql, params = []) { return Object.values((await db.query(sql, params)).rows[0])[0]; }
await asUser(admin);
const room = (await db.query("select * from create_newsroom('Trash test', 'TRASHA123')")).rows[0].newsroom_id;
await asUser(reporter); await db.query("select * from join_newsroom('TRASHA123')");
await asUser(student); await db.query("select * from join_newsroom('TRASHA123')");
await db.query("select claim_producer($1, 'Producer')", [room]);
async function picked() {
    const pitch = await value("select add_pitch($1, 'Council', 'Local angle', '', 'Student')", [room]);
    const story = await value('select pick_pitch($1)', [pitch]);
    return { pitch, story };
}
async function count(pitch) { return value('select count(*)::int from stories where pitch_id = $1', [pitch]); }
async function seed(story, assignment) {
    await db.exec('set session authorization postgres');
    await db.query(`update stories set ${assignment} where id = $1`, [story]);
    await asUser(student);
}
const { pitch, story } = await picked();
assert.equal(await value('select reporter from stories where id = $1', [story]), 'Student');
const rev = await value('select rev from stories where id = $1', [story]);
await db.query("select set_story_reporter($1, '  Alex Reporter  ')", [story]);
assert.equal(await value('select reporter from stories where id = $1', [story]), 'Alex Reporter');
assert.equal(await value('select rev from stories where id = $1', [story]), rev + 1);
await db.query("select set_story_reporter($1, 'Alex Reporter')", [story]);
assert.equal(await value('select rev from stories where id = $1', [story]), rev + 1);
await db.query("select set_story_reporter($1, '')", [story]);
assert.equal(await value('select reporter from stories where id = $1', [story]), '');
await assert.rejects(db.query('select set_story_reporter($1, $2)', [story, 'x'.repeat(61)]), /60 characters/);
console.log('PASS: default reporter, reassignment, trimming, clearing, revision and length limit');
await asUser(reporter);
await assert.rejects(db.query("select set_story_reporter($1, 'Other')", [story]), /Only the producer/);
await asUser(admin);
await assert.rejects(db.query("select set_story_reporter($1, 'Other')", [story]), /Story missing/);
await db.exec('set session authorization anon');
await assert.rejects(db.query("select set_story_reporter($1, 'Other')", [story]), /permission denied/);
await asUser(student);
for (const user of [student, reporter]) {
    await seed(story, `locked_by_session = 'editor', locked_by_user = '${user}', locked_at = now_ms()`);
    await assert.rejects(db.query("select set_story_reporter($1, 'New reporter')", [story]), /editing/);
}
await seed(story, 'locked_at = now_ms() - 60000');
await db.query("select set_story_reporter($1, 'New reporter')", [story]);
console.log('PASS: producer-only assignment; own and other live locks protected; stale locks allowed');
await asUser(admin); await db.query('select start_conference($1)', [room]);
await asUser(student); await db.query("select claim_producer($1, 'Producer')", [room]);
await assert.rejects(db.query("select set_story_reporter($1, 'New')", [story]), /current conference/);
const blank = await value("select add_pitch($1, 'No author', '', '', '')", [room]);
const blankStory = await value('select pick_pitch($1)', [blank]);
assert.equal(await value('select reporter from stories where id = $1', [blankStory]), '');
await db.query('select unpick_pitch($1)', [blank]);
await assert.rejects(db.query("select set_story_reporter($1, 'New')", [blankStory]), /Story missing/);
console.log('PASS: previous conferences and dropped stories rejected; missing author stays unassigned');
await db.close();
