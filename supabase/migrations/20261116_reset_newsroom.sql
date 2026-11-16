-- Admin resets for repurposing a newsroom: clear its running order, or reset
-- everything (conference, producer, running order, members and EP alert) in
-- one go. Safe to rerun.
begin;

-- Empty the running order: every story goes (Undo copies too), leaving just
-- END OF PROGRAMME. Picked pitches in the current conference return to the
-- board as undecided, since their stories are gone. Anything already in Cuez
-- stays there. Refused while a Cuez send is in progress.
create or replace function clear_running_order(p_newsroom_id text)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_sending timestamptz;
  v_conf uuid;
  v_count int;
begin
  perform require_admin();
  select cuez_sending_at, conference_id into v_sending, v_conf from bulletins where id = p_newsroom_id for update;
  if not found then raise exception 'No newsroom with the id %.', p_newsroom_id; end if;
  if v_sending is not null and v_sending > now() - interval '120 seconds' then
    raise exception 'A Cuez send is in progress. Try again in a couple of minutes.';
  end if;
  delete from stories where bulletin_id = p_newsroom_id and type is distinct from 'segment';
  get diagnostics v_count = row_count;
  delete from stories where bulletin_id = p_newsroom_id;
  delete from deleted_stories where bulletin_id = p_newsroom_id;
  update pitches set status = 'pitched', story_id = null, decided_at = null
  where bulletin_id = p_newsroom_id and conference_id = v_conf and status = 'picked';
  update bulletins set order_ids = '["marker-line"]'::jsonb, updated_at = now() where id = p_newsroom_id;
  return v_count;
end;
$$;

-- Ready the newsroom for a new group: a new conference with no producer, an
-- empty running order, no members and no EP alert. The name, join codes,
-- tutors, folder and Cuez target stay. Earlier pitches and EP feedback stay
-- in the database but drop out of the board and the report.
create or replace function reset_newsroom(p_newsroom_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform clear_running_order(p_newsroom_id);
  perform start_conference(p_newsroom_id);
  delete from newsroom_members where bulletin_id = p_newsroom_id;
  update bulletins set ep_alert_text = null, ep_alert_at = null where id = p_newsroom_id;
end;
$$;

revoke execute on function clear_running_order(text), reset_newsroom(text) from public, anon, authenticated;
grant execute on function clear_running_order(text), reset_newsroom(text) to authenticated;

commit;
