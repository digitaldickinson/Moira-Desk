-- Follow-up pitches: a pitch from a BBC News or Manchester Evening News link is
-- a "follow-up" to someone else's journalism. It keeps what the page says about
-- itself (headline, summary, the dates it claims) but never its story text.
-- Before the producer can pick it, three questions must be answered, each with
-- at least 3 non-space characters:
--   follow_when    When did this actually happen?
--   follow_origin  Who is the original source?
--   follow_angle   What's new, or what's our angle?
-- (The pitch's own angle starts as the outlet's headline and is the story's brief.)
-- pick_pitch enforces this, and a trigger refuses any other route to 'picked'.
-- The picked story's script starts with a follow-up note in [directions] that the
-- writer deletes; un-picking still works while the script is just that note.
-- Needs 20261117_pitch_source.sql and 20261117_pitch_source_sites.sql first.
-- Safe to run more than once.
begin;

alter table pitches add column if not exists source_title        text;
alter table pitches add column if not exists source_description  text;
alter table pitches add column if not exists source_published_at timestamptz;
alter table pitches add column if not exists source_modified_at  timestamptz;
alter table pitches add column if not exists follow_when         text;
alter table pitches add column if not exists follow_origin       text;
alter table pitches add column if not exists follow_angle        text;
-- The script a story started with when picked (the follow-up note), so an
-- untouched follow-up story can still be dropped back to the pitches.
alter table stories add column if not exists script_seed text;

-- An earlier version kept the third answer in angle: copy it across once.
update pitches set follow_angle = angle
where source in ('bbc', 'men') and follow_angle is null and (follow_when is not null or follow_origin is not null or status = 'picked');

-- Helpers (internal: only called by the functions and trigger below).
create or replace function is_follow_source(p_source text)
returns boolean language sql immutable as $$
  select coalesce(p_source in ('bbc', 'men'), false)
$$;

create or replace function follow_answered(p text)
returns boolean language sql immutable as $$
  select length(regexp_replace(coalesce(p, ''), '\s', '', 'g')) >= 3
$$;

-- What's still unanswered, as a readable list, or null when all three are done.
create or replace function follow_missing(p_when text, p_origin text, p_angle text)
returns text language sql immutable as $$
  select nullif(array_to_string(array_remove(array[
    case when not follow_answered(p_when)   then 'when it actually happened' end,
    case when not follow_answered(p_origin) then 'who the original source is' end,
    case when not follow_answered(p_angle)  then 'what''s new, or our angle' end
  ], null), ', '), '')
$$;

-- One line of text: whitespace collapsed, capped.
create or replace function one_line(p text, p_max int)
returns text language sql immutable as $$
  select nullif(left(trim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')), p_max), '')
$$;

-- A page's claimed date, or null if it isn't one.
create or replace function safe_timestamptz(p text)
returns timestamptz language plpgsql stable as $$
declare
  v timestamptz;
begin
  if p is null or trim(p) = '' or length(p) > 40 then
    return null;
  end if;
  v := trim(p)::timestamptz;
  return case when v between '1990-01-01'::timestamptz and '2100-01-01'::timestamptz then v end;
exception when others then
  return null;
end;
$$;

-- The note that opens a picked follow-up story's script. Every line is a
-- [direction], so if it's left in it goes to Cuez as instructions, not as
-- words to read. Square brackets in the answers become round ones.
create or replace function follow_note(v pitches)
returns text language sql immutable as $$
  select concat_ws(E'\n',
    '[FOLLOW-UP NOTE: delete these lines once the story is written]',
    '[Follow-up to ' || case v.source when 'bbc' then 'BBC News' else 'Manchester Evening News' end
      || coalesce(': "' || translate(one_line(v.source_title, 300), '[]', '()') || '"', '') || ']',
    '[When it happened: ' || translate(one_line(v.follow_when, 300), '[]', '()') || ']',
    '[Original source: ' || translate(one_line(v.follow_origin, 300), '[]', '()') || ']',
    '[What''s new / our angle: ' || translate(one_line(v.follow_angle, 500), '[]', '()') || ']')
$$;

-- Belt and braces: whatever the route, a follow-up pitch can't become 'picked'
-- with its questions unanswered.
create or replace function pitches_follow_gate()
returns trigger language plpgsql as $$
declare
  v_missing text;
begin
  if new.status = 'picked' and is_follow_source(new.source)
     and (tg_op = 'INSERT' or old.status is distinct from 'picked') then
    v_missing := follow_missing(new.follow_when, new.follow_origin, new.follow_angle);
    if v_missing is not null then
      raise exception 'Follow-up pitch needs: %.', v_missing;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists pitches_follow_gate on pitches;
create trigger pitches_follow_gate before insert or update on pitches
  for each row execute function pitches_follow_gate();

-- add_pitch also takes what the link lookup found on a BBC/MEN page. Drop the
-- seven-argument version so calls without the new arguments aren't ambiguous.
drop function if exists add_pitch(text, text, text, text, text, text, text);
create or replace function add_pitch(p_bulletin_id text, p_slug text, p_angle text, p_format text, p_pitched_by text,
                                     p_source text default null, p_source_url text default null,
                                     p_source_title text default null, p_source_description text default null,
                                     p_source_published_at text default null, p_source_modified_at text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_conf uuid;
  v_id uuid := gen_random_uuid();
  v_source text := nullif(lower(trim(coalesce(p_source, ''))), '');
  v_url text := nullif(trim(coalesce(p_source_url, '')), '');
  v_follow boolean;
begin
  if not is_member(p_bulletin_id) then
    raise exception 'Bulletin missing';
  end if;
  if coalesce(trim(p_slug), '') = '' then
    raise exception 'Give the pitch a slug.';
  end if;
  if v_source is not null and v_source not in ('pa', 'bbc', 'men') then
    raise exception 'Unknown pitch source.';
  end if;
  if v_url is not null and (v_url !~* '^https?://[^[:space:]]+$' or length(v_url) > 2000) then
    raise exception 'The source link must be a web address starting http:// or https://.';
  end if;
  v_follow := is_follow_source(v_source);
  v_conf := current_conference(p_bulletin_id);
  insert into pitches (id, bulletin_id, conference_id, slug, angle, format, pitched_by, created_by, position, source, source_url,
                       source_title, source_description, source_published_at, source_modified_at)
  values (v_id, p_bulletin_id, v_conf, left(trim(p_slug), 80), left(coalesce(trim(p_angle), ''), 500),
          left(coalesce(trim(p_format), ''), 20), left(coalesce(trim(p_pitched_by), ''), 60), auth.uid(),
          coalesce((select max(position) + 1 from pitches where bulletin_id = p_bulletin_id and conference_id = v_conf), 0),
          v_source, v_url,
          case when v_follow then one_line(p_source_title, 300) end,
          case when v_follow then one_line(p_source_description, 500) end,
          case when v_follow then safe_timestamptz(p_source_published_at) end,
          case when v_follow then safe_timestamptz(p_source_modified_at) end);
  return v_id;
end;
$$;

-- Whoever added a follow-up pitch, or the producer, answers its three questions
-- (from the pencil on its card), and can fix its slug at the same time.
-- Blanks are fine until it's picked; a picked one must stay fully answered.
drop function if exists set_follow_answers(uuid, text, text, text);
create or replace function set_follow_answers(p_pitch_id uuid, p_when text, p_origin text, p_angle text, p_slug text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v pitches;
  v_producer uuid;
  v_when text := one_line(p_when, 300);
  v_origin text := one_line(p_origin, 300);
  v_angle text := one_line(p_angle, 500);
  v_missing text;
begin
  v := member_pitch(p_pitch_id);
  if not is_follow_source(v.source) then
    raise exception 'Only BBC News and MEN pitches have follow-up questions.';
  end if;
  select producer_user into v_producer from bulletins where id = v.bulletin_id;
  if v.created_by is distinct from auth.uid() and v_producer is distinct from auth.uid() then
    raise exception 'Only whoever added this pitch, or the producer, can answer its follow-up questions.';
  end if;
  if v.status = 'picked' then
    v_missing := follow_missing(v_when, v_origin, v_angle);
    if v_missing is not null then
      raise exception 'Follow-up pitch needs: %.', v_missing;
    end if;
  end if;
  if p_slug is not null and trim(p_slug) = '' then
    raise exception 'Give the pitch a slug.';
  end if;
  update pitches set follow_when = v_when, follow_origin = v_origin, follow_angle = v_angle,
                     slug = coalesce(left(nullif(trim(p_slug), ''), 80), slug)
  where id = p_pitch_id;
end;
$$;

-- Producer picks a pitch: it becomes a story at the end of the running order
-- (above END OF PROGRAMME), carrying the pitch as its brief and its source link.
-- A follow-up pitch takes its three answers here (null keeps the saved answer),
-- must have all three, and its story's script starts with the follow-up note.
drop function if exists pick_pitch(uuid);
create or replace function pick_pitch(p_pitch_id uuid, p_follow_when text default null,
                                      p_follow_origin text default null, p_follow_angle text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v pitches;
  v_story uuid := gen_random_uuid();
  v_order text[];
  v_idx int;
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

  v_idx := array_position(v_order, 'marker-line');
  if v_idx is not null then
    v_order := v_order[1:v_idx-1] || v_story::text || v_order[v_idx:];
  else
    v_order := v_order || v_story::text || 'marker-line';
  end if;
  update bulletins set order_ids = to_jsonb(v_order), updated_at = now() where id = v.bulletin_id;
  update pitches set status = 'picked', story_id = v_story, spike_reason = null, decided_at = now(),
                     follow_when = v.follow_when, follow_origin = v.follow_origin, follow_angle = v.follow_angle
  where id = p_pitch_id;
  return v_story;
end;
$$;

-- Undo a pick, removing its story, but only while nobody has written it yet
-- (and it hasn't gone to Cuez). A script that's still just the follow-up note it
-- started with counts as unwritten. A story deleted from the running order
-- already can always be un-picked.
create or replace function unpick_pitch(p_pitch_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v pitches;
  s stories;
begin
  v := member_pitch(p_pitch_id);
  perform require_producer(v.bulletin_id);
  if v.status <> 'picked' then
    raise exception 'This pitch isn''t picked.';
  end if;
  perform 1 from bulletins where id = v.bulletin_id for update;
  select * into s from stories where id = v.story_id for update;
  if found then
    if coalesce(s.script, '') not in ('', coalesce(s.script_seed, '')) or s.cuez_item_uid is not null or s.cuez_pending_uid is not null then
      raise exception '"%" has been worked on. Delete it from the running order first if you want to drop it.', s.slug;
    end if;
    -- Someone may be writing it right now with nothing saved yet: their text
    -- would be lost and their save would fail. Any live lock counts, even the
    -- producer's own in another tab.
    if s.locked_by_session is not null and s.locked_at is not null and now_ms() - s.locked_at <= lock_stale_ms() then
      raise exception '% is editing "%" right now, so it can''t be dropped. Try again when they''ve closed it.', coalesce(s.locked_by_name, 'Someone'), s.slug;
    end if;
    delete from stories where id = s.id;
    update bulletins set order_ids = to_jsonb(array_remove(array(select jsonb_array_elements_text(order_ids)), s.id::text)),
                         updated_at = now()
    where id = v.bulletin_id;
  end if;
  -- Drop also invalidates Undo for a story already deleted from the rundown.
  -- The bulletin lock serialises this with delete_story and restore_story.
  delete from deleted_stories where id = v.story_id and bulletin_id = v.bulletin_id;
  update pitches set status = 'pitched', story_id = null, decided_at = null where id = p_pitch_id;
end;
$$;

-- Everything the EP wall and the report need, now with follow-up pitch details.
create or replace function conference_snapshot(p_newsroom_ids text[], p_scripts boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', coalesce(b.name, b.id),
      'producer_name', b.producer_name, 'producer_since', b.producer_since,
      'conference_started_at', b.conference_started_at,
      'target_duration', b.target_duration,
      'cuez_episode_title', b.cuez_episode_title, 'cuez_part_title', b.cuez_part_title,
      'order', b.order_ids,
      'pitches', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', p.id, 'slug', p.slug, 'angle', p.angle, 'format', p.format, 'pitched_by', p.pitched_by,
          'status', p.status, 'spike_reason', p.spike_reason, 'ep_note', p.ep_note,
          'story_id', p.story_id, 'created_at', p.created_at, 'decided_at', p.decided_at,
          'source', p.source, 'source_url', p.source_url,
          'source_title', p.source_title, 'source_published_at', p.source_published_at,
          'source_modified_at', p.source_modified_at,
          'follow_when', p.follow_when, 'follow_origin', p.follow_origin, 'follow_angle', p.follow_angle
        ) order by p.position)
        from pitches p where p.bulletin_id = b.id and p.conference_id = b.conference_id), '[]'::jsonb),
      'stories', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', s.id, 'slug', s.slug, 'format', s.format, 'presenter', s.presenter, 'reporter', s.reporter,
          'duration', s.duration, 'completed', s.completed, 'is_floated', s.is_floated, 'type', s.type,
          'brief', s.brief, 'pitched_by', s.pitched_by, 'rev', s.rev, 'source_url', s.source_url,
          'cuez_item_uid', s.cuez_item_uid, 'cuez_item_number', s.cuez_item_number,
          'cuez_sent_rev', s.cuez_sent_rev, 'cuez_pending_uid', s.cuez_pending_uid,
          'script', case when p_scripts then s.script end
        ))
        from stories s where s.bulletin_id = b.id), '[]'::jsonb),
      'feedback', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', f.id, 'story_id', f.story_id, 'story_slug', f.story_slug, 'quote', f.quote, 'body', f.body,
          'created_at', f.created_at, 'updated_at', f.updated_at
        ) order by f.created_at, f.id)
        from ep_feedback f where f.bulletin_id = b.id and f.conference_id = b.conference_id), '[]'::jsonb)
    ) order by coalesce(b.name, b.id))
    from bulletins b where b.id = any(p_newsroom_ids)), '[]'::jsonb);
end;
$$;

revoke execute on function is_follow_source(text), follow_answered(text), follow_missing(text, text, text),
  one_line(text, int), safe_timestamptz(text), follow_note(pitches), pitches_follow_gate(),
  add_pitch(text, text, text, text, text, text, text, text, text, text, text),
  set_follow_answers(uuid, text, text, text, text), pick_pitch(uuid, text, text, text), unpick_pitch(uuid),
  conference_snapshot(text[], boolean)
  from public, anon, authenticated;
grant execute on function add_pitch(text, text, text, text, text, text, text, text, text, text, text),
  set_follow_answers(uuid, text, text, text, text), pick_pitch(uuid, text, text, text), unpick_pitch(uuid)
  to authenticated;
notify pgrst, 'reload schema';
commit;
