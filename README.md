# Alliance

An online multiplayer take on *Tank Turn Tactics*. Players log in, join a lobby, and fight on a
15×15 wrap-around board where action points arrive once a day at 5pm.

The website is plain HTML/CSS/JS, so it can be hosted for free on **GitHub Pages**. Accounts, the
live game state, the rules and chat run on a free **Supabase** database, so players can't cheat by
editing the page.

---

## 1. Set up the database (Supabase, free, about 5 minutes)

1. Go to https://supabase.com, sign up, and click **New project**. Pick any name and password, and
   choose the region closest to your players (e.g. Sydney).
2. When the project is ready, open **SQL Editor** → **New query**, paste in the whole of
   `schema.sql`, and click **Run**. It should say "Success. No rows returned".
3. Open **Authentication** → **Sign In / Providers** (on some dashboards: **Providers** → **Email**):
   - Make sure **Email** is enabled and **Allow new users to sign up** is on.
   - Turn **OFF "Confirm email"**. This matters: players sign up with only a username, so there is
     no real email address to confirm.
4. Open **Project Settings** → **API** (or **API Keys**) and copy:
   - the **Project URL** (looks like `https://abcdxyz.supabase.co`)
   - the **anon / public** key (or the **publishable** key, `sb_publishable_…`)
5. Paste both into `config.js`. Never use the `service_role` / secret key here.

## 2. Put the website on GitHub Pages

1. Create a GitHub account if you don't have one, then click **New repository**. Name it e.g.
   `alliance` and make it **Public**.
2. Click **uploading an existing file** and drag in `index.html`, `app.js`, `style.css` and
   `config.js` (with your keys filled in). You can also upload `schema.sql` and this README. Then
   click **Commit changes**.
3. In the repo go to **Settings** → **Pages**. Under *Build and deployment*, set Source to
   **Deploy from a branch**, Branch to **main**, folder **/ (root)**, and click **Save**.
4. After about a minute your game is live at `https://YOUR-GITHUB-NAME.github.io/alliance/`.

(Netlify or Cloudflare Pages work too: just drag the folder in.)

## 3. Play

1. Everyone opens the site and creates an account with a username and password.
2. One person creates a lobby and chooses the timezone that "5pm" means. Then they press
   **Copy invite link** and send it to everyone else.
3. The others open the link and press **Join**. When everyone's in, the host presses **Start game**.

---

## Rules as implemented

| | |
|---|---|
| Start | Random empty square, 3 HP, 0 AP, range 2 |
| AP | +1 AP to every surviving tank each day at 5pm (lobby timezone) |
| Mobilise | 1 AP: move one square orthogonally into an empty square (wraps around edges) |
| Attack | 1 AP: target in range loses 1 HP. At 0 HP the tank is removed for good |
| Supply | 1 AP: target in range gains 1 AP (only giver and receiver see who did it in the log) |
| Expand | 2 AP, then 3, 4…: range +1 for the rest of the game |
| Turn timer | Each action starts a private 30-minute timer. Acting before it ends costs +1 AP for each action already taken in that window (2nd action +1, 3rd +2…) and restarts the timer |
| Range | Circular with wrap-around: in range if dx² + dy² ≤ range² |
| End | Last tank alive wins |

Not included, as requested: hearts, gifting hearts, supply drops, revives and the jury.

## Notes

- **No scheduler needed.** The 5pm AP is added the next time anyone opens the game or acts, and it
  catches up if several 5pms were missed. Everyone's displayed AP is always correct once the page
  loads.
- **Who can see what.** Everyone can see the board, HP, AP and range. Only you can see your own turn
  timer. Private chat messages are visible only to the sender and the chosen recipients.
- **Free tier.** Supabase pauses free projects after about a week with no activity. A daily game
  keeps it awake. If it does pause, click **Restore** in the dashboard.
- **Forgotten passwords.** There's no real email, so a password can't be reset by email. You can
  delete the user under Supabase → Authentication → Users so they can sign up again.
- **Testing locally.** Opening `index.html` by double-clicking won't work, because browsers block
  JavaScript modules on `file://`. Use the GitHub Pages link, or run any local web server.
- **Tweaking rules.** Rule values (30-minute timer, 3 HP, range 2, expand cost 2, board size 15)
  are set in `schema.sql`. The 30 minutes also appears as `TURN_MS` in `app.js`.

## Resetting everything

To wipe the database and start again, run this in the SQL Editor, then run `schema.sql` again:

```sql
drop table if exists public.messages, public.events, public.player_private,
  public.players, public.games, public.profiles cascade;
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user, public.in_range, public.next_ap_time,
  public._log, public._grant_ap, public.sync_game, public.create_game, public.join_game,
  public.leave_game, public.start_game, public.act, public.send_message cascade;
```
