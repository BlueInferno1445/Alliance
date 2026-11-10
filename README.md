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
2. One person creates a lobby, chooses its timezone and whether it's **public** or **private**.
   Then they press **Copy invite link** and send it to everyone else.
   - Public lobbies appear on everyone's home page and anyone can join.
   - Private lobbies don't appear anywhere. Only people with the invite link can see and join
     them, and nobody outside the game can spectate.
3. The others open the link and press **Join**. Before starting, the host can **Kick** anyone from
   the waiting room, and kicked players can't rejoin that lobby. When everyone's in, the host
   presses **Start game**.
4. The host can press **Close lobby** at any time during or after the game. This ends the game
   and deletes the board, battle log and chat for everyone.

---

## Rules as implemented

| | |
|---|---|
| Start | Random empty square, 3 HP, 1 AP, range 2 |
| Secrets | Others only see your position. HP, AP, range, class, turn timer and every action you take are private. Everything is revealed when the game ends |
| AP | +1 AP to every surviving tank each day at 5pm (lobby timezone) |
| Mobilise | 1 AP: move one square orthogonally into an empty square (wraps around edges) |
| Attack | 1 AP: target in range loses 1 HP. At 0 HP the tank is removed for good |
| Supply | 1 AP: target in range gains 1 AP (only giver and receiver see who did it in the log) |
| Expand | 2 AP, then 3, 4…: range +1 for the rest of the game |
| Turn timer | Each action starts a private 30-minute timer. Acting before it ends costs +1 AP for each action already taken in that window (2nd action +1, 3rd +2…) and restarts the timer |
| Range | Circular with wrap-around: in range if dx² + dy² ≤ range² |
| End | Last tank alive wins |

These are the defaults. In the waiting room the host can change them, within these limits:

| Setting | Allowed |
|---|---|
| Board size | 3–50 |
| Starting HP | 1–99 |
| Starting AP | 0–999 |
| Starting range | 1–50 |
| Expand starting cost | 0–99 |
| AP per drop | 1–999 |
| Turn timer | 1 second to 7 days |
| AP drop every | 1 second to 30 days, at a chosen time of day and timezone |
| Classes / private lobby | on or off |

Everything locks when the game starts. With very fast AP drops (under 10 minutes apart) the
"AP drop" line is left out of the battle log so it doesn't flood it.

### Classes (optional, toggled per lobby)

Players pick a class in the waiting room. Nobody else can see it until the game ends, and anyone
who doesn't pick gets a random one.

| Class | Effect |
|---|---|
| 🛡️ Bunker | +1 HP |
| 💨 Skirmisher | Moving costs 1 less turn-timer surcharge (2 quick moves = 1+1, 3 quick moves = 4 total) |
| ⚡ Blitz | Start with +1 AP |
| ⏱️ Overclock | Turn timer is 5/6 as long (25 min when the lobby uses 30) |
| 🎯 Artillery | +1 range, but cannot shoot the 4 squares directly touching it (diagonals are fine; supplying still works) |
| ➕ Medic | Repair: 2 AP restores 1 HP to itself or a tank in range, up to that tank's starting HP. Repairing someone already at full HP wastes the AP, and the Medic isn't told |
| 🔭 Sharpshooter | Each shot has a 1 in 6 chance to deal 2 damage |
| 🕵️ Spy | Chooses (free, any time) whose name appears in the target's log when it attacks, destroys or supplies someone, e.g. "You were hit for 1 damage by C" |

Not included, as requested: hearts, gifting hearts, supply drops, revives and the jury.

## Notes

- **No scheduler needed.** AP drops are added the next time anyone opens the game or acts, and they
  catch up if several were missed. Everyone's displayed AP is always correct once the page loads.
- **Who can see what.** The only thing you know for certain about other tanks is their position.
  The public battle log shows lobby events, AP drops and "X was destroyed". Your own log shows
  your actions and their costs. If someone hits, supplies, repairs or destroys you, you're told
  who did it. Private chat messages are visible only to the sender and the chosen recipients.
- **Free tier.** Supabase pauses free projects after about a week with no activity. A daily game
  keeps it awake. If it does pause, click **Restore** in the dashboard.
- **Forgotten passwords.** There's no real email, so a password can't be reset by email. You can
  delete the user under Supabase → Authentication → Users so they can sign up again.
- **Testing locally.** Opening `index.html` by double-clicking won't work, because browsers block
  JavaScript modules on `file://`. Use the GitHub Pages link, or run any local web server.

## Updating or resetting the database

`schema.sql` starts by removing any previous version, so to update or wipe everything just run the
whole file again in the SQL Editor. This deletes all games and chat, but player accounts are kept.
