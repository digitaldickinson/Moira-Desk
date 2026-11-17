-- Pitches from a pasted BBC News or Manchester Evening News link are marked
-- 'bbc' or 'men', alongside 'pa'. Needs 20261117_pitch_source.sql first.
-- Safe to run more than once.
begin;

alter table pitches drop constraint if exists pitches_source_check;
alter table pitches add constraint pitches_source_check check (source is null or source in ('pa', 'bbc', 'men'));

-- add_pitch accepts the new sources.
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
  if v_source is not null and v_source not in ('pa', 'bbc', 'men') then
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

revoke execute on function add_pitch(text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function add_pitch(text, text, text, text, text, text, text) to authenticated;
notify pgrst, 'reload schema';
commit;
