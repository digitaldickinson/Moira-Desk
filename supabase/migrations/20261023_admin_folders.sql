-- Personal admin organisation only; no changes to newsrooms or tutor access.
-- Run the complete file in the Supabase SQL Editor. Safe to rerun.
begin;

create table if not exists admin_folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  unique (id, user_id)
);
create unique index if not exists admin_folders_unique_name on admin_folders(user_id, lower(trim(name)));
create table if not exists admin_folder_newsrooms (
  user_id uuid not null references auth.users(id) on delete cascade,
  bulletin_id text not null references bulletins(id) on delete cascade,
  folder_id uuid not null,
  primary key (user_id, bulletin_id),
  foreign key (folder_id, user_id) references admin_folders(id, user_id) on delete cascade
);
alter table admin_folders enable row level security;
alter table admin_folder_newsrooms enable row level security;
revoke all on admin_folders, admin_folder_newsrooms from public, anon, authenticated;

create or replace function get_admin_folders()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', f.id, 'name', f.name, 'newsroom_ids', coalesce((
      select jsonb_agg(n.bulletin_id order by n.bulletin_id) from admin_folder_newsrooms n
      where n.folder_id = f.id and n.user_id = auth.uid()), '[]'::jsonb)
  ) order by lower(f.name), f.id) from admin_folders f where f.user_id = auth.uid()), '[]'::jsonb);
end;
$$;

create or replace function save_admin_folder(p_name text, p_folder_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_name text := trim(coalesce(p_name, ''));
begin
  if not is_admin() then raise exception 'Admins only.'; end if;
  perform pg_advisory_xact_lock(hashtext('moira:admin-folders'), hashtext(auth.uid()::text));
  if length(v_name) not between 1 and 60 then raise exception 'Folder names need 1 to 60 characters.'; end if;
  if exists (select 1 from admin_folders where user_id = auth.uid() and lower(trim(name)) = lower(v_name)
             and (p_folder_id is null or id <> p_folder_id)) then
    raise exception 'You already have a folder with that name.';
  end if;
  if p_folder_id is null then
    insert into admin_folders(user_id, name) values (auth.uid(), v_name) returning id into v_id;
  else
    update admin_folders set name = v_name where id = p_folder_id and user_id = auth.uid() returning id into v_id;
    if not found then raise exception 'Folder unavailable. Refresh the list.'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function move_admin_newsrooms(p_newsroom_ids text[], p_folder_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only.'; end if;
  perform pg_advisory_xact_lock(hashtext('moira:admin-folders'), hashtext(auth.uid()::text));
  if p_folder_id is not null and not exists (select 1 from admin_folders where id = p_folder_id and user_id = auth.uid()) then
    raise exception 'Folder unavailable. Refresh the list.';
  end if;
  if coalesce(cardinality(p_newsroom_ids), 0) = 0 then raise exception 'Choose at least one newsroom.'; end if;
  if exists (select 1 from unnest(p_newsroom_ids) n(id) where n.id is null or not exists
             (select 1 from bulletins b where b.id = n.id)) then
    raise exception 'A newsroom no longer exists. Refresh the list.';
  end if;
  if p_folder_id is null then
    delete from admin_folder_newsrooms where user_id = auth.uid() and bulletin_id = any(p_newsroom_ids);
  else
    insert into admin_folder_newsrooms(user_id, bulletin_id, folder_id)
      select auth.uid(), id, p_folder_id from (select distinct unnest(p_newsroom_ids) id) chosen
    on conflict (user_id, bulletin_id) do update set folder_id = excluded.folder_id;
  end if;
end;
$$;

create or replace function delete_admin_folder(p_folder_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only.'; end if;
  perform pg_advisory_xact_lock(hashtext('moira:admin-folders'), hashtext(auth.uid()::text));
  -- Cascades only the organisation entries; newsrooms become Unfiled.
  delete from admin_folders where id = p_folder_id and user_id = auth.uid();
  if not found then raise exception 'Folder unavailable. Refresh the list.'; end if;
end;
$$;

revoke execute on function get_admin_folders(), save_admin_folder(text, uuid),
  move_admin_newsrooms(text[], uuid), delete_admin_folder(uuid) from public, anon, authenticated;
grant execute on function get_admin_folders(), save_admin_folder(text, uuid),
  move_admin_newsrooms(text[], uuid), delete_admin_folder(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
