// Run with a temporary PGlite installation via MOIRA_PGLITE_MODULE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.MOIRA_PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const schema = await readFile(new URL('../supabase-schema.sql', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261023_drop_pitch_trash.sql', import.meta.url), 'utf8');
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
// Restore and Drop both lock the bulletin, so these are the two possible
// serial orderings of concurrent requests.
for (const repickFirst of [false, true]) {
    const { pitch, story } = await picked();
    await db.query('select delete_story($1, $2)', [room, story]);
    await db.query('select unpick_pitch($1)', [pitch]);
    if (repickFirst) await db.query('select pick_pitch($1)', [pitch]);
    await asUser(reporter);
    await assert.rejects(db.query('select restore_story($1, $2, 0)', [room, story]), /can no longer be restored/);
    await asUser(student);
    if (!repickFirst) await db.query('select pick_pitch($1)', [pitch]);
    assert.equal(await count(pitch), 1);
}
console.log('PASS: Drop invalidates Rescue before and after repicking, across users');
{
    const { pitch, story } = await picked();
    await db.query('select delete_story($1, $2)', [room, story]);
    await db.query('select restore_story($1, $2, 0)', [room, story]);
    await db.query('select unpick_pitch($1)', [pitch]);
    assert.equal(await count(pitch), 0);
    await db.query('select pick_pitch($1)', [pitch]);
    assert.equal(await count(pitch), 1);
}
console.log('PASS: Rescue before Drop removes the restored untouched story');
for (const assignment of ["script = 'Written script'", "cuez_item_uid = gen_random_uuid()::text", "cuez_pending_uid = gen_random_uuid()::text", "locked_by_session = 'editor', locked_by_name = 'Reporter', locked_at = now_ms()"] ) {
    const { pitch, story } = await picked(); await seed(story, assignment);
    await assert.rejects(db.query('select unpick_pitch($1)', [pitch]), /worked on|editing/);
    assert.equal(await count(pitch), 1);
}
console.log('PASS: live scripts, Cuez sends, pending sends and editing locks still block Drop');
{
    const { pitch, story } = await picked(); await seed(story, "script = 'Written script'");
    await db.query('select delete_story($1, $2)', [room, story]);
    await db.query('select restore_story($1, $2, 0)', [room, story]);
    await assert.rejects(db.query('select unpick_pitch($1)', [pitch]), /worked on/);
    assert.equal(await count(pitch), 1);
    await db.query('select delete_story($1, $2)', [room, story]);
    await db.query('select unpick_pitch($1)', [pitch]);
    await assert.rejects(db.query('select restore_story($1, $2, 0)', [room, story]), /can no longer be restored/);
}
console.log('PASS: restored script stays protected; explicit Drop of deleted script invalidates recovery');
{
    const { pitch, story } = await picked();
    const other = await picked();
    await db.query('select delete_story($1, $2)', [room, story]);
    await db.query('select delete_story($1, $2)', [room, other.story]);
    await asUser(reporter);
    await assert.rejects(db.query('select unpick_pitch($1)', [pitch]), /Only the producer/);
    await db.query('select restore_story($1, $2, 0)', [room, story]);
    await asUser(student);
    await db.query('select unpick_pitch($1)', [pitch]);
    await db.query('select restore_story($1, $2, 0)', [room, other.story]);
    assert.equal(await count(other.pitch), 1);
}
console.log('PASS: unauthorised Drop preserves recovery; unrelated trash remains restorable');
await db.close();
