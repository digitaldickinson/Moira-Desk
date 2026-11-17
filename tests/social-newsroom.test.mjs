// Social newsrooms: the type is set at creation and kept through a reset; a
// social newsroom starts with INTRO and OUTRO, new stories go above the
// closing ONCAM item, sections and shots are stored, and Cuez is refused.
// Run with a temporary PGlite installation via MOIRA_PGLITE_MODULE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.MOIRA_PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const read = (f) => readFile(new URL(f, import.meta.url), 'utf8');
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
const baseline = process.env.MOIRA_BASELINE_SCHEMA ? await readFile(process.env.MOIRA_BASELINE_SCHEMA, 'utf8') : await read('../supabase-schema.sql');
await db.exec(baseline.replace('create extension if not exists pgcrypto;', ''));
// An older migration that recreates the two-argument create_newsroom must not make calls ambiguous.
for (const f of ['20261021_tutor_access.sql', '20261116_reset_newsroom.sql', '20261116_tutor_reset_newsroom.sql',
    '20261117_pitch_source.sql', '20261117_pitch_source_sites.sql', '20261118_follow_pitches.sql', '20261119_source_mix.sql',
    '20261121_social_newsrooms.sql', '20261121_social_newsrooms.sql', '20261021_tutor_access.sql']) {
    await db.exec(await read(`../supabase/migrations/${f}`));
}
for (const fn of ['save_story', 'create_story', 'pick_pitch', 'reset_newsroom_now', 'admin_newsrooms']) {
    assert.equal((await db.query('select count(*)::int as n from pg_proc where proname = $1', [fn])).rows[0].n, 1, `one ${fn}, no overload`);
}

const admin = '00000000-0000-0000-0000-000000000001';
const producer = '00000000-0000-0000-0000-000000000002';
const writer = '00000000-0000-0000-0000-000000000003';
await db.exec(`insert into auth.users values
 ('${admin}', 'admin@example.test', now(), false), ('${producer}', null, null, true), ('${writer}', null, null, true);
 insert into admins(user_id) values ('${admin}');`);
let me = null;
async function asUser(id) {
    me = id;
    await db.exec('set session authorization postgres');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    await db.exec('set session authorization authenticated');
}
const value = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];
// Checks read the tables directly, as the database owner, then go back to the current user.
async function peek(sql, params = []) {
    await db.exec('set session authorization postgres');
    try { return (await db.query(sql, params)).rows; } finally { await asUser(me); }
}
const peekValue = async (sql, params = []) => Object.values((await peek(sql, params))[0])[0];
const order = async (room) => {
    const ids = await peekValue('select order_ids from bulletins where id = $1', [room]);
    const slugs = Object.fromEntries((await peek('select id::text, slug from stories where bulletin_id = $1', [room])).map(r => [r.id, r.slug]));
    return ids.map(id => (id === 'marker-line' ? '|END' : slugs[id] ?? `?${id}`));
};

// Creating: TV by default (both signatures), social on request, nothing else.
await asUser(admin);
const tv = (await db.query("select * from create_newsroom('Newsday Blue', 'BLUE1234')")).rows[0].newsroom_id;
const tv3 = (await db.query("select * from create_newsroom('Newsday Red', 'REDD1234', 'TV')")).rows[0].newsroom_id;
const social = (await db.query("select * from create_newsroom('Group 1', 'GRP11234', 'social')")).rows[0].newsroom_id;
assert.deepEqual((await peek('select id, kind from bulletins order by id')).map(r => [r.id, r.kind]),
    [['bulletin-group-1', 'social'], ['bulletin-newsday-blue', 'tv'], ['bulletin-newsday-red', 'tv']]);
assert.deepEqual(await order(tv), ['TOP STORY', '|END'], 'TV newsrooms start as before');
assert.deepEqual(await order(social), ['INTRO', 'OUTRO', '|END']);
assert.deepEqual(await peekValue('select formats from bulletins where id = $1', [social]), ['OOV/CLIP', 'ONCAM']);
assert.deepEqual((await peek("select slug, format, sections->0->>'treatment' as t from stories where bulletin_id = $1 order by slug", [social])),
    [{ slug: 'INTRO', format: 'ONCAM', t: 'presenter' }, { slug: 'OUTRO', format: 'ONCAM', t: 'presenter' }]);
await assert.rejects(db.query("select * from create_newsroom('Group 2', 'GRP21234', 'radio')"), /either TV or Social/);
assert.equal((await db.query('select kind from admin_newsrooms() where newsroom_id = $1', [social])).rows[0].kind, 'social');
await asUser(producer);
await assert.rejects(db.query("select * from create_newsroom('Sneaky', 'SNEAKY12', 'social')"), /Admins only/);
console.log('PASS: TV by default, social on request; a social newsroom starts with INTRO and OUTRO');

// Students can't change the type.
for (const u of [producer, writer]) {
    await asUser(u);
    await db.query("select * from join_newsroom('GRP11234')");
    await db.query("select * from join_newsroom('BLUE1234')");
}
await asUser(producer);
await assert.rejects(db.query("update bulletins set kind = 'tv' where id = $1", [social]), /permission denied/);
assert.equal(await peekValue('select kind from bulletins where id = $1', [social]), 'social');
console.log('PASS: browsers cannot change a newsroom\'s type');

// New stories go above the closing ONCAM item, with their sections and shots.
await asUser(writer);
const sections = [{ title: 'Story', says: 'Rents are up again.', treatment: 'dual', onscreen: 'Rents up', clip: '0:05' }];
const shots = { a: { source: 'pa', link: 'https://explore.pressassociation.com/x', credit: 'PA' }, b: { source: 'own', link: '', credit: '' } };
const added = '11111111-1111-4111-8111-111111111111';
await db.query('select create_story($1, $2, $3)', [social, added, { slug: 'HOUSING', format: 'OOV/CLIP', script: 'Rents are up again.', sections, shots }]);
assert.deepEqual(await order(social), ['INTRO', 'HOUSING', 'OUTRO', '|END']);
const saved = (await db.query('select sections, shots from stories where id = $1', [added])).rows[0];
assert.deepEqual(saved, { sections, shots });
await assert.rejects(db.query('select create_story($1, $2, $3)', [social, '22222222-2222-4222-8222-222222222222', { slug: 'BAD', sections: { not: 'a list' } }]), /up to 20 sections/);
await assert.rejects(db.query('select create_story($1, $2, $3)', [social, '22222222-2222-4222-8222-222222222222',
    { slug: 'BAD', sections: Array.from({ length: 21 }, () => ({ says: 'x' })) }]), /up to 20 sections/);

// Saving: sections and shots change when sent, and stay when not.
await db.query('select save_story($1, $2, 1)', [added, { sections: [{ ...sections[0], says: 'Rents rise again.' }], script: 'Rents rise again.' }]);
assert.equal(await value("select sections->0->>'says' from stories where id = $1", [added]), 'Rents rise again.');
assert.deepEqual(await value('select shots from stories where id = $1', [added]), shots, 'shots kept when not sent');
await db.query('select save_story($1, $2, 2)', [added, { slug: 'STUDENT HOUSING' }]);
assert.equal(await value("select sections->0->>'says' from stories where id = $1", [added]), 'Rents rise again.', 'sections kept when not sent');
await assert.rejects(db.query('select save_story($1, $2, 3)', [added, { shots: ['not', 'an', 'object'] }]), /Unknown shot details/);
console.log('PASS: new stories go above OUTRO; sections and shots are saved and kept');

// Deleting and restoring keeps them too.
await db.query('select delete_story($1, $2)', [social, added]);
await db.query('select restore_story($1, $2, 1)', [social, added]);
assert.deepEqual((await db.query('select sections, shots from stories where id = $1', [added])).rows[0].shots, shots);
assert.deepEqual(await order(social), ['INTRO', 'STUDENT HOUSING', 'OUTRO', '|END']);

// Picking: straight into the running order, above OUTRO, as OOV/CLIP.
await asUser(producer);
await db.query("select claim_producer($1, 'Producer')", [social]);
const pitch = await value("select add_pitch($1, 'Tram strike', 'Drivers walk out', '', 'Writer')", [social]);
await db.query('select pick_pitch($1)', [pitch]);
assert.deepEqual(await order(social), ['INTRO', 'STUDENT HOUSING', 'TRAM STRIKE', 'OUTRO', '|END']);
assert.equal(await value("select format from stories where slug = 'TRAM STRIKE' and bulletin_id = $1", [social]), 'OOV/CLIP');
// Without a closing ONCAM item, a pick goes to the end.
const outro = await value("select id::text from stories where slug = 'OUTRO' and bulletin_id = $1", [social]);
await db.query('select move_story($1, $2, $3)', [social, outro, await value("select id::text from stories where slug = 'TRAM STRIKE' and bulletin_id = $1", [social])]);
const pitch2 = await value("select add_pitch($1, 'Food bank', 'Demand doubles', '', 'Writer')", [social]);
await db.query('select pick_pitch($1)', [pitch2]);
assert.deepEqual(await order(social), ['INTRO', 'STUDENT HOUSING', 'OUTRO', 'TRAM STRIKE', 'FOOD BANK', '|END']);
// TV picks still go just above END OF PROGRAMME, after a closing READ or ONCAM alike.
await db.query("select claim_producer($1, 'Producer')", [tv]);
await asUser(writer);
await db.query('select create_story($1, $2, $3)', [tv, '33333333-3333-4333-8333-333333333333', { slug: 'CLOSE', format: 'ONCAM' }]);
await asUser(producer);
const tvPitch = await value("select add_pitch($1, 'Council', 'Vote tonight', '', 'Writer')", [tv]);
await db.query('select pick_pitch($1)', [tvPitch]);
assert.deepEqual(await order(tv), ['TOP STORY', 'CLOSE', 'COUNCIL', '|END']);
console.log('PASS: picks go straight in above OUTRO in social newsrooms; TV newsrooms unchanged');

// Cuez: no target for a social newsroom; clearing is still allowed. TV unaffected.
await asUser(admin);
const ep = '0f8fad5b-d9cb-469f-a165-70867728950e', part = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
await assert.rejects(db.query("select set_cuez_target($1, $2, 'Ep', $3, 'Part')", [social, ep, part]), /don't send to Cuez/);
await db.query('select set_cuez_target($1, null, null, null, null)', [social]);
await db.query("select set_cuez_target($1, $2, 'Ep', $3, 'Part')", [tv, ep, part]);
assert.equal(await peekValue('select cuez_part_uid from bulletins where id = $1', [tv]), part);
console.log('PASS: social newsrooms refuse a Cuez target');

// Reset: the type stays; a social newsroom gets INTRO and OUTRO back.
await db.query('select reset_newsroom($1)', [social]);
await db.query('select reset_newsroom($1)', [tv3]);
assert.equal(await peekValue('select kind from bulletins where id = $1', [social]), 'social');
assert.deepEqual(await order(social), ['INTRO', 'OUTRO', '|END']);
assert.equal(await peekValue('select count(*)::int from newsroom_members where bulletin_id = $1', [social]), 0);
assert.equal(await peekValue('select kind from bulletins where id = $1', [tv3]), 'tv');
assert.deepEqual(await order(tv3), ['|END']);
console.log('PASS: a reset keeps the type, and a social newsroom restarts from INTRO and OUTRO');
