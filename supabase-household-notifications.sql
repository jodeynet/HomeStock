-- Run this once in the Supabase SQL Editor for the HomeStock project.
-- Adds a private, per-household activity feed with per-user read markers.

create table if not exists public.household_activity_notifications (
    id bigint generated always as identity primary key,
    household_id uuid not null references public.households(id) on delete cascade,
    actor_user_id uuid references auth.users(id) on delete set null,
    source_table text not null,
    action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
    item_name text,
    created_at timestamptz not null default pg_catalog.now()
);

create index if not exists household_activity_notifications_household_id_id_idx
    on public.household_activity_notifications (household_id, id desc);

alter table public.household_activity_notifications enable row level security;
revoke all on table public.household_activity_notifications from public, anon, authenticated;

create table if not exists public.household_notification_reads (
    user_id uuid primary key references auth.users(id) on delete cascade,
    household_id uuid not null references public.households(id) on delete cascade,
    last_seen_id bigint not null default 0
);

alter table public.household_notification_reads enable row level security;
revoke all on table public.household_notification_reads from public, anon, authenticated;

create or replace function public.log_household_activity_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_row jsonb;
    v_household_id uuid;
    v_item_name text;
begin
    if tg_op = 'DELETE' then
        v_row := pg_catalog.to_jsonb(old);
    else
        v_row := pg_catalog.to_jsonb(new);
    end if;

    v_household_id := nullif(v_row ->> 'household_id', '')::uuid;
    if v_household_id is null then
        if tg_op = 'DELETE' then
            return old;
        end if;
        return new;
    end if;

    if tg_table_name = 'household_notes' then
        v_item_name := 'Household notes';
    elsif tg_table_name = 'shopping_trips' then
        v_item_name := 'Shopping trip';
    else
        v_item_name := coalesce(
            nullif(pg_catalog.btrim(v_row ->> 'name'), ''),
            nullif(pg_catalog.btrim(v_row ->> 'item_name'), ''),
            nullif(pg_catalog.btrim(v_row ->> 'title'), '')
        );
    end if;

    insert into public.household_activity_notifications (
        household_id,
        actor_user_id,
        source_table,
        action,
        item_name
    ) values (
        v_household_id,
        auth.uid(),
        tg_table_name,
        tg_op,
        v_item_name
    );

    if tg_op = 'DELETE' then
        return old;
    end if;
    return new;
end;
$$;

do $$
declare
    v_table_name text;
begin
    foreach v_table_name in array array['shopping_list', 'items', 'shopping_trips', 'household_notes']
    loop
        if pg_catalog.to_regclass(pg_catalog.format('public.%I', v_table_name)) is null then
            raise exception 'Table public.% does not exist. Run its HomeStock SQL setup first.', v_table_name;
        end if;

        execute pg_catalog.format(
            'drop trigger if exists household_activity_notification_trigger on public.%I',
            v_table_name
        );
        execute pg_catalog.format(
            'create trigger household_activity_notification_trigger after insert or update or delete on public.%I for each row execute function public.log_household_activity_notification()',
            v_table_name
        );
    end loop;
end;
$$;

create or replace function public.get_unread_household_notifications()
returns table (
    notification_id bigint,
    source_table text,
    action text,
    item_name text,
    actor_name text,
    created_at timestamptz,
    unread_count bigint,
    latest_notification_id bigint
)
language sql
stable
security definer
set search_path = ''
as $$
    with current_household as (
        select hm.household_id
        from public.household_members as hm
        where hm.user_id = auth.uid()
        limit 1
    ),
    read_marker as (
        select coalesce(
            (
                select hnr.last_seen_id
                from public.household_notification_reads as hnr
                join current_household as ch on ch.household_id = hnr.household_id
                where hnr.user_id = auth.uid()
            ),
            0
        ) as last_seen_id
    ),
    unread as (
        select han.*
        from public.household_activity_notifications as han
        join current_household as ch on ch.household_id = han.household_id
        cross join read_marker as rm
        where han.id > rm.last_seen_id
          and han.actor_user_id is distinct from auth.uid()
    )
    select
        u.notification_id,
        u.source_table,
        u.action,
        u.item_name,
        coalesce(
            nullif(pg_catalog.btrim(pg_catalog.concat_ws(
                ' ',
                actor.raw_user_meta_data ->> 'first_name',
                actor.raw_user_meta_data ->> 'last_name'
            )), ''),
            nullif(pg_catalog.btrim(actor.raw_user_meta_data ->> 'full_name'), ''),
            nullif(pg_catalog.btrim(actor.raw_user_meta_data ->> 'name'), ''),
            pg_catalog.split_part(actor.email, '@', 1),
            'A household member'
        ) as actor_name,
        u.created_at,
        (select pg_catalog.count(*) from unread) as unread_count,
        (select pg_catalog.max(unread.id) from unread) as latest_notification_id
    from (
        select
            unread.id as notification_id,
            unread.source_table,
            unread.action,
            unread.item_name,
            unread.actor_user_id,
            unread.created_at
        from unread
        order by unread.id desc
        limit 50
    ) as u
    left join auth.users as actor on actor.id = u.actor_user_id
    order by u.notification_id desc;
$$;

create or replace function public.mark_household_notifications_read(p_last_notification_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_household_id uuid;
    v_last_seen_id bigint;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in to update notification status.';
    end if;
    if p_last_notification_id is null or p_last_notification_id < 0 then
        raise exception 'Invalid notification cursor.';
    end if;

    select hm.household_id
    into v_household_id
    from public.household_members as hm
    where hm.user_id = auth.uid()
    limit 1;

    if v_household_id is null then
        raise exception 'Your account is not assigned to a household.';
    end if;

    select pg_catalog.max(han.id)
    into v_last_seen_id
    from public.household_activity_notifications as han
    where han.household_id = v_household_id
      and han.id <= p_last_notification_id
      and han.actor_user_id is distinct from auth.uid();

    if v_last_seen_id is null then
        return;
    end if;

    insert into public.household_notification_reads as current_read (user_id, household_id, last_seen_id)
    values (auth.uid(), v_household_id, v_last_seen_id)
    on conflict (user_id) do update
    set household_id = excluded.household_id,
        last_seen_id = greatest(current_read.last_seen_id, excluded.last_seen_id);
end;
$$;

revoke all on function public.log_household_activity_notification() from public, anon, authenticated;
revoke all on function public.get_unread_household_notifications() from public, anon;
revoke all on function public.mark_household_notifications_read(bigint) from public, anon;
grant execute on function public.get_unread_household_notifications() to authenticated;
grant execute on function public.mark_household_notifications_read(bigint) to authenticated;
