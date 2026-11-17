-- Source mix: every pitch has a source_type, worked out by the database from
-- how it was added, so existing pitches are classified automatically and it
-- can never disagree with source:
--   wire      dropped in from PA (source 'pa')
--   follow    a BBC News / MEN follow-up (source 'bbc' or 'men')
--   original  everything else: typed in, or with a link from any other site
-- PA drops now also keep the dragged headline in source_title. Promotion is
-- the existing state (status 'picked', with decided_at as when); no new column.
-- Needs 20261118_follow_pitches.sql first. Safe to run more than once.
begin;

alter table pitches add column if not exists source_type text
  generated always as (case when source = 'pa' then 'wire'
                            when source in ('bbc', 'men') then 'follow'
                            else 'original' end) stored;

-- add_pitch: unchanged except that a PA drop's headline is kept too.
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
          case when v_follow or v_source = 'pa' then one_line(p_source_title, 300) end,
          case when v_follow then one_line(p_source_description, 500) end,
          case when v_follow then safe_timestamptz(p_source_published_at) end,
          case when v_follow then safe_timestamptz(p_source_modified_at) end);
  return v_id;
end;
$$;

-- Everything the EP wall and the report need, now with each pitch's source_type.
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
          'source', p.source, 'source_type', p.source_type, 'source_url', p.source_url,
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

revoke execute on function add_pitch(text, text, text, text, text, text, text, text, text, text, text),
  conference_snapshot(text[], boolean) from public, anon, authenticated;
grant execute on function add_pitch(text, text, text, text, text, text, text, text, text, text, text) to authenticated;
notify pgrst, 'reload schema';
commit;
