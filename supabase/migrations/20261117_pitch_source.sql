-- Pitches dropped in from the PA wire keep where they came from: a source
-- marker ('pa') and the story link. Picking the pitch carries the link to the
-- story, where the editor shows it with the pitch brief. The link is never
-- part of the script, so it doesn't reach the prompter or Cuez.
-- Safe to run more than once.
begin;

alter table pitches add column if not exists source     text;
alter table pitches add column if not exists source_url text;
alter table stories add column if not exists source_url text;

alter table pitches drop constraint if exists pitches_source_check;
alter table pitches add constraint pitches_source_check check (source is null or source = 'pa');
alter table pitches drop constraint if exists pitches_source_url_check;
alter table pitches add constraint pitches_source_url_check
  check (source_url is null or (source_url ~* '^https?://[^[:space:]]+$' and length(source_url) <= 2000));
alter table stories drop constraint if exists stories_source_url_check;
alter table stories add constraint stories_source_url_check
  check (source_url is null or (source_url ~* '^https?://[^[:space:]]+$' and length(source_url) <= 2000));

-- add_pitch gains two optional arguments. Drop the old five-argument version
-- first so calls without them aren't ambiguous; they still work via the defaults.
drop function if exists add_pitch(text, text, text, text, text);
create or replace function add_pitch(p_bulletin_id text, p_slug text, p_angle text, p_format text, p_pitched_by text,
                                     p_source text default null, p_source_url text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_conf uuid;
  v_id uuid := gen_random_uuid();
  v_source text := nullif(lower(trim(coalesce(p_source, ''))), '');
  v_url text := nullif(trim(coalesce(p_source_url, '')), '');
begin
  if not is_member(p_bulletin_id) then
    raise exception 'Bulletin missing';
  end if;
  if coalesce(trim(p_slug), '') = '' then
    raise exception 'Give the pitch a slug.';
  end if;
  if v_source is not null and v_source <> 'pa' then
    raise exception 'Unknown pitch source.';
  end if;
  if v_url is not null and (v_url !~* '^https?://[^[:space:]]+$' or length(v_url) > 2000) then
    raise exception 'The source link must be a web address starting http:// or https://.';
  end if;
  v_conf := current_conference(p_bulletin_id);
  insert into pitches (id, bulletin_id, conference_id, slug, angle, format, pitched_by, created_by, position, source, source_url)
  values (v_id, p_bulletin_id, v_conf, left(trim(p_slug), 80), left(coalesce(trim(p_angle), ''), 500),
          left(coalesce(trim(p_format), ''), 20), left(coalesce(trim(p_pitched_by), ''), 60), auth.uid(),
          coalesce((select max(position) + 1 from pitches where bulletin_id = p_bulletin_id and conference_id = v_conf), 0),
          v_source, v_url);
  return v_id;
end;
$$;

-- Producer picks a pitch: it becomes a story at the end of the running order
-- (above END OF PROGRAMME), carrying the pitch as its brief and its source link.
create or replace function pick_pitch(p_pitch_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v pitches;
  v_story uuid := gen_random_uuid();
  v_order text[];
  v_idx int;
  v_format text;
begin
  v := member_pitch(p_pitch_id);
  perform require_producer(v.bulletin_id);
  if v.status = 'picked' then
    raise exception 'Already picked.';
  end if;
  select array(select jsonb_array_elements_text(order_ids)), coalesce(nullif(v.format, ''), formats->>0, 'READ')
    into v_order, v_format
  from bulletins where id = v.bulletin_id for update;

  insert into stories (id, bulletin_id, slug, format, reporter, duration, rev, brief, pitched_by, pitch_id, source_url)
  values (v_story, v.bulletin_id, upper(v.slug), v_format, left(coalesce(trim(v.pitched_by), ''), 60), 10, 1, nullif(v.angle, ''), nullif(v.pitched_by, ''), v.id, v.source_url);

  v_idx := array_position(v_order, 'marker-line');
  if v_idx is not null then
    v_order := v_order[1:v_idx-1] || v_story::text || v_order[v_idx:];
  else
    v_order := v_order || v_story::text || 'marker-line';
  end if;
  update bulletins set order_ids = to_jsonb(v_order), updated_at = now() where id = v.bulletin_id;
  update pitches set status = 'picked', story_id = v_story, spike_reason = null, decided_at = now() where id = p_pitch_id;
  return v_story;
end;
$$;

-- Everything the EP wall and the report need, now with each pitch's source.
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
          'source', p.source, 'source_url', p.source_url
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

revoke execute on function add_pitch(text, text, text, text, text, text, text), conference_snapshot(text[], boolean)
  from public, anon, authenticated;
grant execute on function add_pitch(text, text, text, text, text, text, text) to authenticated;
notify pgrst, 'reload schema';
commit;
