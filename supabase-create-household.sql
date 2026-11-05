-- Run this once in the Supabase SQL Editor for the HomeStock project.
-- Household creation and membership assignment are performed atomically by the RPC.

alter table public.households
    add column if not exists name text;

create or replace function public.create_household_for_current_user(p_household_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_household_id uuid;
    v_household_name text := pg_catalog.btrim(p_household_name);
begin
    if v_user_id is null then
        raise exception 'You must be signed in to create a household.';
    end if;
    if v_household_name is null or v_household_name = '' or pg_catalog.char_length(v_household_name) > 60 then
        raise exception 'Enter a household name between 1 and 60 characters.';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::text, 0));

    select hm.household_id
    into v_household_id
    from public.household_members as hm
    where hm.user_id = v_user_id
    limit 1;

    if v_household_id is not null then
        return v_household_id;
    end if;

    insert into public.households (name)
    values (v_household_name)
    returning id into v_household_id;

    insert into public.household_members (household_id, user_id)
    values (v_household_id, v_user_id);

    return v_household_id;
end;
$$;

revoke all on function public.create_household_for_current_user(text) from public, anon;
grant execute on function public.create_household_for_current_user(text) to authenticated;

create or replace function public.get_current_household_name()
returns text
language sql
stable
security definer
set search_path = ''
as $$
    select h.name
    from public.household_members as hm
    join public.households as h on h.id = hm.household_id
    where hm.user_id = auth.uid()
    limit 1;
$$;

revoke all on function public.get_current_household_name() from public, anon;
grant execute on function public.get_current_household_name() to authenticated;
