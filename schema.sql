-- =====================================================================
--  ALLIANCE  -  database, rules and game logic (Supabase / Postgres)
--  Paste this WHOLE file into Supabase > SQL Editor > New query > Run.
--  All game rules are enforced here on the server, so nobody can cheat
--  by editing the website in their browser.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table public.profiles (
  id        uuid primary key references auth.users(id) on delete cascade,
  username  text not null unique check (username ~ '^[a-z0-9_]{3,20}$')
);

create table public.games (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(name) between 1 and 40),
  host_id        uuid not null references public.profiles(id) on delete cascade,
  status         text not null default 'waiting' check (status in ('waiting','active','finished')),
  board_size     int  not null default 15,
  timezone       text not null default 'Australia/Sydney',  -- whose "5pm" the game uses
  last_ap_grant  timestamptz,
  winner_id      uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz
);

create table public.players (
  game_id      uuid not null references public.games(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  username     text not null,
  x            int,
  y            int,
  hp           int  not null default 3,
  ap           int  not null default 0,
  reach        int  not null default 2,   -- shooting / supply range
  expand_cost  int  not null default 2,
  alive        boolean not null default true,
  joined_at    timestamptz not null default now(),
  primary key (game_id, user_id)
);

-- Turn-timer state. Only the owner can read their own row.
create table public.player_private (
  game_id         uuid not null,
  user_id         uuid not null,
  last_action_at  timestamptz,
  streak          int not null default 0,  -- actions taken inside the current 30-min window
  primary key (game_id, user_id),
  foreign key (game_id, user_id) references public.players(game_id, user_id) on delete cascade
);

create table public.events (
  id          bigserial primary key,
  game_id     uuid not null references public.games(id) on delete cascade,
  body        text not null,
  visible_to  uuid[],                      -- null = everyone
  created_at  timestamptz not null default now()
);
create index on public.events (game_id, id);

create table public.messages (
  id           bigserial primary key,
  game_id      uuid not null references public.games(id) on delete cascade,
  sender_id    uuid not null references public.profiles(id) on delete cascade,
  sender_name  text not null,
  recipients   uuid[],                     -- null = whole lobby
  body         text not null check (char_length(body) between 1 and 500),
  created_at   timestamptz not null default now()
);
create index on public.messages (game_id, id);

-- ---------------------------------------------------------------------
-- Row level security (read-only for players; all writes go through
-- the functions below)
-- ---------------------------------------------------------------------
alter table public.profiles       enable row level security;
alter table public.games          enable row level security;
alter table public.players        enable row level security;
alter table public.player_private enable row level security;
alter table public.events         enable row level security;
alter table public.messages       enable row level security;

create policy "profiles readable" on public.profiles for select to authenticated using (true);
create policy "games readable"    on public.games    for select to authenticated using (true);
create policy "players readable"  on public.players  for select to authenticated using (true);
create policy "own turn timer"    on public.player_private for select to authenticated
  using (user_id = auth.uid());
create policy "events visible"    on public.events   for select to authenticated
  using (visible_to is null or auth.uid() = any(visible_to));
create policy "messages visible"  on public.messages for select to authenticated
  using (
    sender_id = auth.uid()
    or auth.uid() = any(recipients)
    or (recipients is null and exists (
          select 1 from public.players p
           where p.game_id = messages.game_id and p.user_id = auth.uid()))
  );

-- Live updates
alter publication supabase_realtime add table
  public.games, public.players, public.player_private, public.events, public.messages;

-- ---------------------------------------------------------------------
-- Sign-up: create a profile from the username
-- ---------------------------------------------------------------------
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (new.id, lower(new.raw_user_meta_data ->> 'username'));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
-- Circular range on a board whose edges wrap around.
create function public.in_range(x1 int, y1 int, x2 int, y2 int, r int, n int)
returns boolean language sql immutable as $$
  select dx * dx + dy * dy <= r * r
    from (select least(abs(x1 - x2), n - abs(x1 - x2)) as dx,
                 least(abs(y1 - y2), n - abs(y1 - y2)) as dy) d
$$;

-- The first 5pm (in the game's timezone) strictly after a moment.
create function public.next_ap_time(after_ts timestamptz, tz text)
returns timestamptz language plpgsql stable as $$
declare t timestamptz;
begin
  t := (((after_ts at time zone tz)::date) + time '17:00') at time zone tz;
  if t <= after_ts then
    t := (((after_ts at time zone tz)::date + 1) + time '17:00') at time zone tz;
  end if;
  return t;
end $$;

create function public._log(p_game uuid, p_body text, p_visible uuid[] default null)
returns void language sql security definer set search_path = public as $$
  insert into public.events (game_id, body, visible_to) values (p_game, p_body, p_visible);
$$;

-- Hands out every 5pm AP that has passed since the last grant.
-- Runs whenever anyone loads the game or acts, so no scheduler is needed.
create function public._grant_ap(p_game uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  g      public.games;
  t      timestamptz;
  last_t timestamptz;
  n      int := 0;
begin
  select * into g from public.games where id = p_game for update;
  if not found or g.status <> 'active' then return; end if;

  t := public.next_ap_time(g.last_ap_grant, g.timezone);
  while t <= now() loop
    n := n + 1;
    last_t := t;
    t := public.next_ap_time(t, g.timezone);
  end loop;

  if n > 0 then
    update public.players set ap = ap + n where game_id = p_game and alive;
    update public.games set last_ap_grant = last_t where id = p_game;
    perform public._log(p_game, format('5pm supply: every surviving tank gained %s AP.', n));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Functions the website calls
-- ---------------------------------------------------------------------
create function public.sync_game(p_game uuid)
returns json language plpgsql security definer set search_path = public as $$
declare tz text;
begin
  perform public._grant_ap(p_game);
  select timezone into tz from public.games where id = p_game;
  if tz is null then return null; end if;
  return json_build_object('next_ap', public.next_ap_time(now(), tz), 'server_now', now());
end $$;

create function public.create_game(p_name text, p_timezone text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_name text;
  v_gid  uuid;
begin
  if v_uid is null then raise exception 'Not logged in'; end if;
  select username into v_name from public.profiles where id = v_uid;
  begin
    perform (now() at time zone p_timezone);
  exception when others then
    raise exception 'Unknown timezone %', p_timezone;
  end;
  insert into public.games (name, host_id, timezone)
  values (trim(p_name), v_uid, p_timezone) returning id into v_gid;
  insert into public.players (game_id, user_id, username) values (v_gid, v_uid, v_name);
  perform public._log(v_gid, v_name || ' created the lobby.');
  return v_gid;
end $$;

create function public.join_game(p_game uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_name text;
  g      public.games;
begin
  if v_uid is null then raise exception 'Not logged in'; end if;
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'Lobby not found'; end if;
  if g.status <> 'waiting' then raise exception 'This game has already started'; end if;
  if (select count(*) from public.players where game_id = p_game) >= g.board_size * g.board_size then
    raise exception 'Lobby is full';
  end if;
  select username into v_name from public.profiles where id = v_uid;
  insert into public.players (game_id, user_id, username) values (p_game, v_uid, v_name)
  on conflict do nothing;
  if found then perform public._log(p_game, v_name || ' joined the lobby.'); end if;
end $$;

-- Leave a lobby before it starts. If the host leaves, the lobby is deleted.
create function public.leave_game(p_game uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  g     public.games;
  v_name text;
begin
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'Lobby not found'; end if;
  if g.status <> 'waiting' then raise exception 'You can only leave before the game starts'; end if;
  if g.host_id = v_uid then
    delete from public.games where id = p_game;
  else
    delete from public.players where game_id = p_game and user_id = v_uid returning username into v_name;
    if v_name is not null then perform public._log(p_game, v_name || ' left the lobby.'); end if;
  end if;
end $$;

create function public.start_game(p_game uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  g   public.games;
  cnt int;
begin
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'Lobby not found'; end if;
  if g.host_id <> auth.uid() then raise exception 'Only the host can start the game'; end if;
  if g.status <> 'waiting' then raise exception 'Game already started'; end if;
  select count(*) into cnt from public.players where game_id = p_game;
  if cnt < 2 then raise exception 'Need at least 2 players'; end if;

  -- Random, non-overlapping starting squares
  with cells as (
    select cx, cy, row_number() over (order by random()) as rn
      from generate_series(0, g.board_size - 1) cx, generate_series(0, g.board_size - 1) cy
  ), ps as (
    select user_id, row_number() over (order by random()) as rn
      from public.players where game_id = p_game
  )
  update public.players p
     set x = c.cx, y = c.cy, hp = 3, ap = 0, reach = 2, expand_cost = 2, alive = true
    from ps join cells c on c.rn = ps.rn
   where p.game_id = p_game and p.user_id = ps.user_id;

  insert into public.player_private (game_id, user_id)
  select game_id, user_id from public.players where game_id = p_game
  on conflict do nothing;

  update public.games
     set status = 'active', started_at = now(), last_ap_grant = now()
   where id = p_game;

  perform public._log(p_game, format(
    'The game has begun! %s tanks deployed. First AP arrives at 5pm (%s).', cnt, g.timezone));
end $$;

-- The four actions: move | attack | supply | expand
-- p_max_cost: the cost the player was shown; if the real cost is higher
-- (e.g. clocks disagree about the turn timer) the action is refused.
create function public.act(
  p_game uuid, p_action text, p_target uuid default null,
  p_dir text default null, p_max_cost int default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  g       public.games;
  me      public.players;
  tgt     public.players;
  priv    public.player_private;
  v_pen   int;
  v_base  int;
  v_cost  int;
  v_nx    int;
  v_ny    int;
  v_alive int;
  v_win   public.players;
begin
  if v_uid is null then raise exception 'Not logged in'; end if;

  perform public._grant_ap(p_game);
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'Game not found'; end if;
  if g.status <> 'active' then raise exception 'This game is not in progress'; end if;

  select * into me from public.players where game_id = p_game and user_id = v_uid for update;
  if not found or not me.alive then raise exception 'You do not have a tank on this board'; end if;

  select * into priv from public.player_private where game_id = p_game and user_id = v_uid for update;
  if priv.last_action_at is not null and now() - priv.last_action_at < interval '30 minutes' then
    v_pen := priv.streak;
  else
    v_pen := 0;
  end if;

  v_base := case p_action
              when 'expand' then me.expand_cost
              when 'move'   then 1
              when 'attack' then 1
              when 'supply' then 1
            end;
  if v_base is null then raise exception 'Unknown action'; end if;
  v_cost := v_base + v_pen;

  if p_max_cost is not null and v_cost > p_max_cost then
    raise exception 'This action now costs % AP (turn timer). Please try again.', v_cost;
  end if;
  if me.ap < v_cost then raise exception 'Not enough AP: this needs %', v_cost; end if;

  if p_action = 'move' then
    v_nx := me.x; v_ny := me.y;
    case p_dir
      when 'up'    then v_ny := v_ny - 1;
      when 'down'  then v_ny := v_ny + 1;
      when 'left'  then v_nx := v_nx - 1;
      when 'right' then v_nx := v_nx + 1;
      else raise exception 'Invalid direction';
    end case;
    v_nx := ((v_nx % g.board_size) + g.board_size) % g.board_size;
    v_ny := ((v_ny % g.board_size) + g.board_size) % g.board_size;
    if exists (select 1 from public.players
                where game_id = p_game and alive and x = v_nx and y = v_ny) then
      raise exception 'That space is occupied';
    end if;
    update public.players set x = v_nx, y = v_ny, ap = ap - v_cost
     where game_id = p_game and user_id = v_uid;
    perform public._log(p_game, format('%s mobilised %s.', me.username, p_dir));

  elsif p_action in ('attack', 'supply') then
    if p_target is null or p_target = v_uid then raise exception 'Choose another player'; end if;
    select * into tgt from public.players where game_id = p_game and user_id = p_target for update;
    if not found or not tgt.alive then raise exception 'That player is not on the board'; end if;
    if not public.in_range(me.x, me.y, tgt.x, tgt.y, me.reach, g.board_size) then
      raise exception '% is out of range', tgt.username;
    end if;

    update public.players set ap = ap - v_cost where game_id = p_game and user_id = v_uid;

    if p_action = 'supply' then
      update public.players set ap = ap + 1 where game_id = p_game and user_id = p_target;
      -- Only the giver and receiver see who supplied whom
      perform public._log(p_game, format('%s supplied 1 AP to %s.', me.username, tgt.username),
                          array[v_uid, p_target]);
    else
      update public.players
         set hp    = hp - 1,
             alive = hp - 1 > 0,
             x     = case when hp - 1 > 0 then x end,
             y     = case when hp - 1 > 0 then y end
       where game_id = p_game and user_id = p_target;

      if tgt.hp - 1 > 0 then
        perform public._log(p_game, format('%s attacked %s (%s HP left).',
                                           me.username, tgt.username, tgt.hp - 1));
      else
        perform public._log(p_game, format('%s destroyed %s! Their tank is removed from the board.',
                                           me.username, tgt.username));
        select count(*) into v_alive from public.players where game_id = p_game and alive;
        if v_alive <= 1 then
          select * into v_win from public.players where game_id = p_game and alive limit 1;
          update public.games set status = 'finished', finished_at = now(), winner_id = v_win.user_id
           where id = p_game;
          perform public._log(p_game, format('%s is the last tank standing and wins the game!',
                                             v_win.username));
        end if;
      end if;
    end if;

  else -- expand
    update public.players
       set reach = reach + 1, expand_cost = expand_cost + 1, ap = ap - v_cost
     where game_id = p_game and user_id = v_uid;
    perform public._log(p_game, format('%s expanded their range to %s.', me.username, me.reach + 1));
  end if;

  update public.player_private
     set last_action_at = now(), streak = v_pen + 1
   where game_id = p_game and user_id = v_uid;

  return json_build_object('ok', true, 'cost', v_cost);
end $$;

create function public.send_message(p_game uuid, p_body text, p_recipients uuid[] default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_name text;
  v_rec  uuid[];
begin
  select username into v_name from public.players where game_id = p_game and user_id = v_uid;
  if v_name is null then raise exception 'You are not in this game'; end if;
  p_body := trim(p_body);
  if p_body = '' or char_length(p_body) > 500 then
    raise exception 'Messages must be 1-500 characters';
  end if;
  if p_recipients is not null and cardinality(p_recipients) > 0 then
    select array_agg(user_id) into v_rec from public.players
     where game_id = p_game and user_id = any(p_recipients) and user_id <> v_uid;
    if v_rec is null then raise exception 'No valid recipients'; end if;
  end if;
  insert into public.messages (game_id, sender_id, sender_name, recipients, body)
  values (p_game, v_uid, v_name, v_rec, p_body);
end $$;

-- ---------------------------------------------------------------------
-- Permissions: only logged-in players may call the public functions
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.sync_game(uuid),
  public.create_game(text, text),
  public.join_game(uuid),
  public.leave_game(uuid),
  public.start_game(uuid),
  public.act(uuid, text, uuid, text, int),
  public.send_message(uuid, text, uuid[])
to authenticated;
