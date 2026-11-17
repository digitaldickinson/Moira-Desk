-- Social newsrooms. Each newsroom is either 'tv' (the running order that goes
-- to Cuez) or 'social' (a social media bulletin, planned shot by shot). The
-- type is chosen by an admin when the newsroom is created and never changes:
-- browsers can't write it (their column grant on bulletins is formats and
-- target_duration only), no function changes it, and a reset keeps it.
--
-- A social newsroom:
--   * starts, and restarts after a reset, with INTRO and OUTRO (ONCAM);
--   * puts new stories, picked or added, before a closing ONCAM item;
--   * keeps each story's sections (what's said, the picture, on-screen text,
--     clip length) and its shots (where the pictures come from, and credits)
--     in two jsonb columns. The page also saves the sections as an ordinary
--     script, so the prompters, reports and EP wall need no changes;
--   * never sends to Cuez (set_cuez_target refuses, and so does send-to-cuez).
--
-- Existing newsrooms are all 'tv'. To make existing ones social, once, in the
-- SQL Editor (the only way to change a newsroom's type), then reset them from
-- the admin page so each starts from INTRO and OUTRO:
--   update bulletins set kind = 'social', formats = '["OOV/CLIP", "ONCAM"]'
--   where name ~ '^Group [0-9]+$';
-- Safe to run more than once.
begin;

alter table bulletins add column if not exists kind text not null default 'tv';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bulletins_kind_check') then
    alter table bulletins add constraint bulletins_kind_check check (kind in ('tv', 'social'));
  end if;
end $$;
alter table stories add column if not exists sections jsonb;  -- social: [{title, says, treatment, onscreen, clip}]
alter table stories add column if not exists shots    jsonb;  -- social: {a: {source, link, ...}, b: {...}}

-- Social story data: a list of sections and a shots object, kept to a sensible size.
create or replace function check_social_values(p_sections jsonb, p_shots jsonb)
returns void language plpgsql immutable as $$
begin
  if p_sections is not null and (jsonb_typeof(p_sections) <> 'array' or jsonb_array_length(p_sections) > 20
     or exists (select 1 from jsonb_array_elements(p_sections) e where jsonb_typeof(e) <> 'object')) then
    raise exception 'A story can have up to 20 sections.';
  end if;
  if p_shots is not null and jsonb_typeof(p_shots) <> 'object' then
    raise exception 'Unknown shot details.';
  end if;
  if octet_length(coalesce(p_sections::text, '')) + octet_length(coalesce(p_shots::text, '')) > 100000 then
    raise exception 'This story is too long to save.';
  end if;
end;
$$;

-- Where a new story goes in the running order. TV: just above END OF
-- PROGRAMME. Social: also above a closing ONCAM item (the outro), if there is one.
create or replace function rundown_insert(p_bulletin_id text, p_order text[], p_id text)
returns text[] language plpgsql stable security definer set search_path = public as $$
declare
  v_idx int := array_position(p_order, 'marker-line');
  v_last text;
begin
  if v_idx is null then
    p_order := p_order || 'marker-line'::text;
    v_idx := array_length(p_order, 1);
  end if;
  if (select kind from bulletins where id = p_bulletin_id) = 'social' and v_idx > 1 then
    v_last := p_order[v_idx - 1];
    if exists (select 1 from stories s where s.id::text = v_last and s.bulletin_id = p_bulletin_id
               and upper(s.format) = 'ONCAM' and s.type is distinct from 'segment') then
      v_idx := v_idx - 1;
    end if;
  end if;
  return p_order[1:v_idx - 1] || p_id || p_order[v_idx:];
end;
$$;

-- A social newsroom's starting running order: INTRO and OUTRO, both ONCAM.
-- Returns the new order_ids. Internal: called by create_newsroom and the reset.
create or replace function social_template(p_bulletin_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_intro uuid := gen_random_uuid();
  v_outro uuid := gen_random_uuid();
  v_section jsonb := jsonb_build_object('title', '', 'says', '', 'treatment', 'presenter', 'onscreen', '', 'clip', '');
begin
  insert into stories (id, bulletin_id, slug, format, sections) values
    (v_intro, p_bulletin_id, 'INTRO', 'ONCAM', jsonb_build_array(v_section || jsonb_build_object('title', 'Welcome'))),
    (v_outro, p_bulletin_id, 'OUTRO', 'ONCAM', jsonb_build_array(v_section || jsonb_build_object('title', 'Sign-off')));
  return jsonb_build_array(v_intro::text, v_outro::text, 'marker-line');
end;
$$;

create or replace function create_story(p_bulletin_id text, p_story_id uuid, p_story jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_order text[];
begin
  if not is_member(p_bulletin_id) then
    raise exception 'Bulletin missing';
  end if;
  select array(select jsonb_array_elements_text(order_ids)) into v_order
  from bulletins where id = p_bulletin_id for update;
  if v_order is null then
    raise exception 'Bulletin missing';
  end if;
  perform check_story_values(p_story->>'completed', p_story->>'type');
  perform check_social_values(nullif(p_story->'sections', 'null'::jsonb), nullif(p_story->'shots', 'null'::jsonb));

  insert into stories (id, bulletin_id, slug, script, format, presenter, reporter, duration, completed, is_floated, type, rev, sections, shots)
  values (
    p_story_id, p_bulletin_id,
    coalesce(p_story->>'slug', ''), coalesce(p_story->>'script', ''), coalesce(p_story->>'format', ''),
    coalesce(p_story->>'presenter', ''), coalesce(p_story->>'reporter', ''),
    coalesce((p_story->>'duration')::int, 0), p_story->>'completed',
    coalesce((p_story->>'is_floated')::boolean, false), p_story->>'type', 1,
    nullif(p_story->'sections', 'null'::jsonb), nullif(p_story->'shots', 'null'::jsonb)
  );
  update bulletins set order_ids = to_jsonb(rundown_insert(p_bulletin_id, v_order, p_story_id::text)), updated_at = now()
  where id = p_bulletin_id;
end;
$$;

create or replace function save_story(p_story_id uuid, p_data jsonb, p_expected_rev int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_row stories;
  v_sections jsonb;
  v_shots jsonb;
begin
  v_row := member_story(p_story_id);
  if v_row.rev <> p_expected_rev then
    return jsonb_build_object('status', 'conflict', 'server', to_jsonb(v_row));
  end if;
  if locked_by_other(v_row) then
    raise exception '% is editing this story now. Copy your text somewhere safe, then try again when they''ve finished.', coalesce(v_row.locked_by_name, 'Someone else');
  end if;
  perform check_story_values(coalesce(p_data->>'completed', v_row.completed), coalesce(p_data->>'type', v_row.type));
  v_sections := case when p_data ? 'sections' then nullif(p_data->'sections', 'null'::jsonb) else v_row.sections end;
  v_shots    := case when p_data ? 'shots'    then nullif(p_data->'shots', 'null'::jsonb)    else v_row.shots end;
  perform check_social_values(v_sections, v_shots);

  update stories set
    slug = coalesce(p_data->>'slug', slug),
    script = coalesce(p_data->>'script', script),
    format = coalesce(p_data->>'format', format),
    presenter = coalesce(p_data->>'presenter', presenter),
    reporter = coalesce(p_data->>'reporter', reporter),
    duration = coalesce((p_data->>'duration')::int, duration),
    completed = coalesce(p_data->>'completed', completed),
    is_floated = coalesce((p_data->>'is_floated')::boolean, is_floated),
    type = coalesce(p_data->>'type', type),
    sections = v_sections,
    shots = v_shots,
    rev = v_row.rev + 1,
    locked_by_session = null, locked_by_name = null, locked_at = null, locked_by_user = null
  where id = p_story_id;

  return jsonb_build_object('status', 'ok');
end;
$$;

-- As before, but the story goes where rundown_insert says (above a social outro).
create or replace function pick_pitch(p_pitch_id uuid, p_follow_when text default null,
                                      p_follow_origin text default null, p_follow_angle text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v pitches;
  v_story uuid := gen_random_uuid();
  v_order text[];
  v_format text;
  v_missing text;
  v_note text;
begin
  v := member_pitch(p_pitch_id);
  perform require_producer(v.bulletin_id);
  if v.status = 'picked' then
    raise exception 'Already picked.';
  end if;
  if is_follow_source(v.source) then
    if p_follow_when   is not null then v.follow_when   := one_line(p_follow_when, 300); end if;
    if p_follow_origin is not null then v.follow_origin := one_line(p_follow_origin, 300); end if;
    if p_follow_angle  is not null then v.follow_angle  := one_line(p_follow_angle, 500); end if;
    v_missing := follow_missing(v.follow_when, v.follow_origin, v.follow_angle);
    if v_missing is not null then
      raise exception 'Follow-up pitch needs: %.', v_missing;
    end if;
    v_note := follow_note(v);
  end if;
  select array(select jsonb_array_elements_text(order_ids)), coalesce(nullif(v.format, ''), formats->>0, 'READ')
    into v_order, v_format
  from bulletins where id = v.bulletin_id for update;

  insert into stories (id, bulletin_id, slug, format, reporter, duration, rev, brief, pitched_by, pitch_id, source_url, script, script_seed)
  values (v_story, v.bulletin_id, upper(v.slug), v_format, left(coalesce(trim(v.pitched_by), ''), 60), 10, 1, nullif(v.angle, ''),
          nullif(v.pitched_by, ''), v.id, v.source_url, coalesce(v_note, ''), v_note);

  update bulletins set order_ids = to_jsonb(rundown_insert(v.bulletin_id, v_order, v_story::text)), updated_at = now()
  where id = v.bulletin_id;
  update pitches set status = 'picked', story_id = v_story, spike_reason = null, decided_at = now(),
                     follow_when = v.follow_when, follow_origin = v.follow_origin, follow_angle = v.follow_angle
  where id = p_pitch_id;
  return v_story;
end;
$$;

-- create_newsroom with the newsroom's type ('tv' or 'social'). Its arguments
-- have no defaults, so it never competes with the two-argument version below,
-- which stays (an older migration recreates it) and makes a TV newsroom.
create or replace function create_newsroom(p_name text, p_code text, p_kind text)
returns table (newsroom_id text, join_code text)
language plpgsql security definer set search_path = public as $$
declare
  v_id text := 'bulletin-' || trim(both '-' from regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'));
  v_code text := coalesce(nullif(trim(p_code), ''), random_code());
  v_kind text := lower(coalesce(nullif(trim(p_kind), ''), 'tv'));
  v_story uuid := gen_random_uuid();
begin
  perform require_admin();
  perform pg_advisory_xact_lock(hashtext('moira-desk:codes'));
  if v_id = 'bulletin-' then
    raise exception 'Give the newsroom a name.';
  end if;
  if v_kind not in ('tv', 'social') then
    raise exception 'A newsroom is either TV or Social.';
  end if;
  if exists (select 1 from bulletins b where b.id = v_id) then
    raise exception 'A newsroom with the id % already exists.', v_id;
  end if;
  if length(regexp_replace(upper(v_code), '[^A-Z0-9]', '', 'g')) < 6 then
    raise exception 'Codes need at least 6 letters or numbers.';
  end if;
  if exists (select 1 from newsroom_codes c where c.code_hash = code_hash(v_code)) or exists (select 1 from tutor_join_codes c where c.code_hash = code_hash(v_code)) then
    raise exception 'That code is already used by another newsroom.';
  end if;

  if v_kind = 'social' then
    insert into bulletins (id, name, kind, formats, order_ids) values (v_id, trim(p_name), 'social', '["OOV/CLIP", "ONCAM"]'::jsonb, '["marker-line"]'::jsonb);
    update bulletins set order_ids = social_template(v_id) where id = v_id;
  else
    insert into bulletins (id, name, order_ids) values (v_id, trim(p_name), jsonb_build_array(v_story::text, 'marker-line'));
    insert into stories (id, bulletin_id, slug, script, format, duration)
    values (v_story, v_id, 'TOP STORY', 'Good evening. Welcome to the news from ' || trim(p_name) || '...', 'OVO', 30);
  end if;
  insert into newsroom_codes (bulletin_id, code_hash) values (v_id, code_hash(v_code));
  return query select v_id, v_code;
end;
$$;

create or replace function create_newsroom(p_name text, p_code text default null)
returns table (newsroom_id text, join_code text)
language sql security definer set search_path = public as $$
  select * from create_newsroom(p_name, p_code, 'tv');
$$;

-- A reset keeps the type; a social newsroom gets its INTRO and OUTRO back.
create or replace function reset_newsroom_now(p_newsroom_id text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_sending timestamptz;
  v_kind text;
begin
  select cuez_sending_at, kind into v_sending, v_kind from bulletins where id = p_newsroom_id for update;
  if not found then raise exception 'No newsroom with the id %.', p_newsroom_id; end if;
  if v_sending is not null and v_sending > now() - interval '120 seconds' then
    raise exception 'A Cuez send is in progress. Try again in a couple of minutes.';
  end if;
  delete from stories where bulletin_id = p_newsroom_id;
  delete from deleted_stories where bulletin_id = p_newsroom_id;
  delete from newsroom_members where bulletin_id = p_newsroom_id;
  update bulletins set order_ids = case when v_kind = 'social' then social_template(p_newsroom_id) else '["marker-line"]'::jsonb end,
                       conference_id = gen_random_uuid(), conference_started_at = now(),
                       producer_user = null, producer_name = null, producer_since = null,
                       ep_alert_text = null, ep_alert_at = null, updated_at = now()
  where id = p_newsroom_id;
end;
$$;

-- Social newsrooms don't send to Cuez, so they can't be given a target.
create or replace function set_cuez_target(
  p_newsroom_id text, p_episode_id text, p_episode_title text,
  p_part_uid text, p_part_title text, p_clear_sent boolean default false,
  p_read_speed integer default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uuid text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  perform require_admin();
  if p_episode_id is not null and (select kind from bulletins where id = p_newsroom_id) = 'social' then
    raise exception 'Social newsrooms don''t send to Cuez.';
  end if;
  if (p_episode_id is null) <> (p_part_uid is null) then
    raise exception 'Set both the episode and the part, or neither.';
  end if;
  if p_episode_id is not null and (p_episode_id !~* v_uuid or p_part_uid !~* v_uuid) then
    raise exception 'Episode and part must be Cuez IDs.';
  end if;
  update bulletins set
    cuez_episode_id = lower(p_episode_id), cuez_episode_title = p_episode_title,
    cuez_part_uid = lower(p_part_uid), cuez_part_title = p_part_title,
    cuez_read_speed = case when p_read_speed between 60 and 400 then p_read_speed else cuez_read_speed end,
    updated_at = now()
  where id = p_newsroom_id;
  if p_clear_sent then
    update stories set cuez_item_uid = null, cuez_sent_at = null, cuez_sent_rev = null, cuez_item_number = null,
                       cuez_pending_uid = null, cuez_pending_at = null, cuez_pending_rev = null, cuez_pending_plan = null
    where bulletin_id = p_newsroom_id and (cuez_item_uid is not null or cuez_pending_uid is not null);
  end if;
end;
$$;

-- The admin list shows each newsroom's type.
drop function if exists admin_newsrooms();
create or replace function admin_newsrooms()
returns table (
  newsroom_id text, name text, members bigint, stories bigint, sent_stories bigint,
  has_code boolean, code_updated_at timestamptz,
  cuez_episode_id text, cuez_episode_title text, cuez_part_uid text, cuez_part_title text,
  created_at timestamptz,
  producer_name text, conference_started_at timestamptz, pitches bigint, picked bigint, kind text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return query
    select b.id, coalesce(b.name, b.id),
           (select count(*) from newsroom_members m where m.bulletin_id = b.id),
           (select count(*) from stories s where s.bulletin_id = b.id and s.type is distinct from 'segment'),
           (select count(*) from stories s where s.bulletin_id = b.id and s.cuez_item_uid is not null),
           c.bulletin_id is not null, c.updated_at,
           b.cuez_episode_id, b.cuez_episode_title, b.cuez_part_uid, b.cuez_part_title, b.created_at,
           b.producer_name, b.conference_started_at,
           (select count(*) from pitches p where p.bulletin_id = b.id and p.conference_id = b.conference_id),
           (select count(*) from pitches p where p.bulletin_id = b.id and p.conference_id = b.conference_id and p.status = 'picked'),
           b.kind
    from bulletins b left join newsroom_codes c on c.bulletin_id = b.id
    order by b.created_at desc;
end;
$$;

revoke execute on function check_social_values(jsonb, jsonb), rundown_insert(text, text[], text), social_template(text),
  create_newsroom(text, text, text), create_newsroom(text, text), admin_newsrooms() from public, anon, authenticated;
grant execute on function create_newsroom(text, text, text), create_newsroom(text, text), admin_newsrooms() to authenticated;

commit;
