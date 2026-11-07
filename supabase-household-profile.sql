-- Run this once in the Supabase SQL Editor for the HomeStock project.

create or replace function public.get_household_members_for_current_user()
returns table (user_id uuid, email text, display_name text, role text)
language sql
stable
security definer
set search_path = ''
as $$
    select
        u.id,
        u.email::text,
        coalesce(
            nullif(pg_catalog.btrim(pg_catalog.concat_ws(
                ' ',
                u.raw_user_meta_data ->> 'first_name',
                u.raw_user_meta_data ->> 'last_name'
            )), ''),
            nullif(pg_catalog.btrim(u.raw_user_meta_data ->> 'full_name'), ''),
            nullif(pg_catalog.btrim(u.raw_user_meta_data ->> 'name'), ''),
            pg_catalog.split_part(u.email, '@', 1)
        ) as display_name,
        hm.role
    from public.household_members as hm
    join auth.users as u on u.id = hm.user_id
    where hm.household_id = (
        select current_member.household_id
        from public.household_members as current_member
        where current_member.user_id = auth.uid()
        limit 1
    )
    order by hm.role desc, display_name;
$$;

revoke all on function public.get_household_members_for_current_user() from public, anon;
grant execute on function public.get_household_members_for_current_user() to authenticated;

create or replace function public.update_current_household_name(p_household_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_household_id uuid;
    v_household_name text := pg_catalog.btrim(p_household_name);
begin
    if auth.uid() is null then
        raise exception 'You must be signed in to update your household.';
    end if;
    if v_household_name is null or v_household_name = '' or pg_catalog.char_length(v_household_name) > 60 then
        raise exception 'Enter a household name between 1 and 60 characters.';
    end if;

    select hm.household_id
    into v_household_id
    from public.household_members as hm
    where hm.user_id = auth.uid()
      and hm.role = 'owner'
    limit 1;

    if v_household_id is null then
        raise exception 'Only the household owner can change the household name.';
    end if;

    update public.households
    set name = v_household_name
    where id = v_household_id;

    if not found then
        raise exception 'Your household could not be found.';
    end if;
end;
$$;

revoke all on function public.update_current_household_name(text) from public, anon;
grant execute on function public.update_current_household_name(text) to authenticated;

create or replace function public.remove_household_member(p_member_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_household_id uuid;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in to manage household members.';
    end if;
    if p_member_user_id is null then
        raise exception 'Choose a household member to remove.';
    end if;
    if p_member_user_id = auth.uid() then
        raise exception 'You cannot remove yourself from the household.';
    end if;

    select hm.household_id
    into v_household_id
    from public.household_members as hm
    where hm.user_id = auth.uid()
      and hm.role = 'owner'
    limit 1;

    if v_household_id is null then
        raise exception 'Only the household owner can remove members.';
    end if;

    delete from public.household_members as target
    where target.household_id = v_household_id
      and target.user_id = p_member_user_id
      and target.role = 'member';

    if not found then
        raise exception 'That household member could not be found or cannot be removed.';
    end if;
end;
$$;

revoke all on function public.remove_household_member(uuid) from public, anon;
grant execute on function public.remove_household_member(uuid) to authenticated;
