import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Usernames are turned into a dummy email so Supabase's password login can be used.
const EMAIL_DOMAIN = 'players.alliance.game';
const TURN_MS = 30 * 60 * 1000;

const configured = !SUPABASE_URL.includes('YOUR-') && !SUPABASE_ANON_KEY.includes('YOUR-');
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const S = {
  user: null, username: null,
  gameId: null, game: null, players: [], me: null, priv: null,
  events: [], messages: [],
  nextAp: null, clockOffset: 0, syncing: false,
  selected: null, chatTo: new Set(),
  channel: null, refreshTimer: null, lastPenalty: null, lobbyTimer: null,
};

// ---------------------------------------------------------------- utils
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now() + S.clockOffset;
const byId = (uid) => S.players.find((p) => p.user_id === uid);

function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ''), 4000);
}

function show(view) {
  for (const v of ['auth', 'lobby', 'game']) $('view-' + v).classList.toggle('hidden', v !== view);
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function hue(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function inRange(from, x, y) {
  if (from?.x == null || x == null) return false;
  const n = S.game.board_size;
  let dx = Math.abs(from.x - x), dy = Math.abs(from.y - y);
  dx = Math.min(dx, n - dx);
  dy = Math.min(dy, n - dy);
  return dx * dx + dy * dy <= from.reach * from.reach;
}

// Extra AP owed because the 30-minute turn timer is still running.
function penalty() {
  const p = S.priv;
  if (!p?.last_action_at) return 0;
  return now() - new Date(p.last_action_at).getTime() < TURN_MS ? p.streak : 0;
}

for (const id of ['rules-auth', 'rules-lobby']) $(id).innerHTML = $('rules-tpl').innerHTML;

// ---------------------------------------------------------------- auth
$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!sb) return toast('Fill in config.js first', true);
  const mode = e.submitter?.dataset.mode ?? 'login';
  const u = $('auth-user').value.trim().toLowerCase();
  const pw = $('auth-pass').value;
  if (!/^[a-z0-9_]{3,20}$/.test(u)) return toast('Username must be 3–20 letters, numbers or _', true);
  if (pw.length < 6) return toast('Password must be at least 6 characters', true);
  const email = `${u}@${EMAIL_DOMAIN}`;

  if (mode === 'signup') {
    const { data, error } = await sb.auth.signUp({ email, password: pw, options: { data: { username: u } } });
    if (error) return toast(/already|exists/i.test(error.message) ? 'That username is taken' : error.message, true);
    if (!data.session) return toast('Account made but not logged in. Turn OFF "Confirm email" in Supabase (see README).', true);
    toast(`Welcome, ${u}!`);
  } else {
    const { error } = await sb.auth.signInWithPassword({ email, password: pw });
    if (error) return toast('Wrong username or password', true);
  }
});

async function onSession(session) {
  const uid = session?.user?.id ?? null;
  if (uid === (S.user?.id ?? undefined)) return;
  S.user = session?.user ?? null;
  if (!S.user) {
    closeGame();
    $('whoami').innerHTML = '';
    show('auth');
    return;
  }
  const { data } = await sb.from('profiles').select('username').eq('id', S.user.id).maybeSingle();
  S.username = data?.username ?? S.user.user_metadata?.username ?? '?';
  $('whoami').innerHTML = `<span>${esc(S.username)}</span><button id="logout" class="ghost small">Log out</button>`;
  $('logout').onclick = () => sb.auth.signOut();
  route();
}

if (sb) {
  sb.auth.onAuthStateChange((_event, session) => setTimeout(() => onSession(session), 0));
} else {
  $('config-warning').classList.remove('hidden');
  show('auth');
}

// ---------------------------------------------------------------- routing
function route() {
  if (!S.user) return show('auth');
  const m = location.hash.match(/game=([0-9a-f-]{36})/i);
  if (m) openGame(m[1]);
  else { closeGame(); openLobby(); }
}
window.addEventListener('hashchange', route);
$('back').onclick = () => (location.hash = '');

// ---------------------------------------------------------------- lobby list
const tzSelect = $('create-tz');
const myTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [myTz, 'UTC'];
tzSelect.innerHTML = zones.map((z) => `<option ${z === myTz ? 'selected' : ''}>${esc(z)}</option>`).join('');

async function openLobby() {
  show('lobby');
  clearInterval(S.lobbyTimer);
  S.lobbyTimer = setInterval(() => { if (!S.gameId && S.user) loadLobby(); }, 15000);
  loadLobby();
}

async function loadLobby() {
  const { data, error } = await sb.from('games')
    .select('id,name,status,host_id,timezone,created_at,winner_id,players(user_id,username,alive)')
    .order('created_at', { ascending: false })
    .limit(60);
  if (error) return toast(error.message, true);

  const mine = [], open = [], other = [];
  for (const g of data) {
    const member = g.players.some((p) => p.user_id === S.user.id);
    (member ? mine : g.status === 'waiting' ? open : other).push(gameCard(g, member));
  }
  const empty = (msg) => `<p class="muted small">${msg}</p>`;
  $('lobby-mine').innerHTML = mine.join('') || empty("You're not in any games yet.");
  $('lobby-open').innerHTML = open.join('') || empty('No open lobbies. Create one!');
  $('lobby-other').innerHTML = other.join('') || empty('Nothing to spectate.');
}

function gameCard(g, member) {
  const host = g.players.find((p) => p.user_id === g.host_id)?.username ?? '?';
  const alive = g.players.filter((p) => p.alive).length;
  const winner = g.players.find((p) => p.user_id === g.winner_id)?.username;
  const info = g.status === 'waiting' ? `${g.players.length} in lobby`
    : g.status === 'active' ? `${alive}/${g.players.length} tanks alive`
    : `Winner: ${winner ?? 'none'}`;
  const btn = !member && g.status === 'waiting'
    ? `<button data-join="${g.id}" class="small">Join</button>`
    : `<button data-open="${g.id}" class="small ghost">${member ? 'Open' : 'Watch'}</button>`;
  return `<div class="card">
    <div><b>${esc(g.name)}</b><span class="muted small">Host ${esc(host)} · ${info} · ${esc(g.timezone)}</span></div>
    <div class="row"><span class="badge ${g.status}">${g.status}</span>${btn}</div></div>`;
}

$('view-lobby').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.open) location.hash = 'game=' + b.dataset.open;
  if (b.dataset.join) joinGame(b.dataset.join);
});
$('lobby-refresh').onclick = loadLobby;

$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { data, error } = await sb.rpc('create_game', {
    p_name: $('create-name').value.trim(), p_timezone: tzSelect.value,
  });
  if (error) return toast(error.message, true);
  $('create-name').value = '';
  location.hash = 'game=' + data;
});

async function joinGame(id) {
  const { error } = await sb.rpc('join_game', { p_game: id });
  if (error) return toast(error.message, true);
  toast('Joined!');
  if (location.hash === '#game=' + id) refreshGame();
  else location.hash = 'game=' + id;
}

// ---------------------------------------------------------------- game: data
async function openGame(id) {
  clearInterval(S.lobbyTimer);
  if (S.gameId === id) return;
  closeGame();
  S.gameId = id;
  S.selected = null;
  S.chatTo = new Set();
  S.lastPenalty = null;
  show('game');
  $('board').innerHTML = '';
  $('chat-log').innerHTML = '';
  subscribe(id);
  await syncAp();
  await refreshGame();
}

function closeGame() {
  if (S.channel) sb.removeChannel(S.channel);
  Object.assign(S, { channel: null, gameId: null, game: null, players: [], me: null, priv: null, nextAp: null });
}

function subscribe(id) {
  const ch = sb.channel('game-' + id);
  const tables = [
    ['games', `id=eq.${id}`], ['players', `game_id=eq.${id}`], ['player_private', `game_id=eq.${id}`],
    ['events', `game_id=eq.${id}`], ['messages', `game_id=eq.${id}`],
  ];
  for (const [table, filter] of tables) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table, filter }, scheduleRefresh);
  }
  ch.subscribe();
  S.channel = ch;
}

function scheduleRefresh() {
  clearTimeout(S.refreshTimer);
  S.refreshTimer = setTimeout(refreshGame, 150);
}

// Asks the server to hand out any 5pm AP that is due, and learns the next 5pm.
async function syncAp() {
  if (!S.gameId || S.syncing) return;
  S.syncing = true;
  const sent = Date.now();
  const { data, error } = await sb.rpc('sync_game', { p_game: S.gameId });
  S.syncing = false;
  if (error || !data) return;
  S.nextAp = new Date(data.next_ap).getTime();
  S.clockOffset = new Date(data.server_now).getTime() - (sent + Date.now()) / 2;
}

async function refreshGame() {
  const id = S.gameId;
  if (!id || !S.user) return;
  const [g, p, pr, ev, msg] = await Promise.all([
    sb.from('games').select('*').eq('id', id).maybeSingle(),
    sb.from('players').select('*').eq('game_id', id).order('joined_at'),
    sb.from('player_private').select('*').eq('game_id', id).eq('user_id', S.user.id).maybeSingle(),
    sb.from('events').select('*').eq('game_id', id).order('id', { ascending: false }).limit(150),
    sb.from('messages').select('*').eq('game_id', id).order('id', { ascending: false }).limit(200),
  ]);
  if (id !== S.gameId) return;
  if (!g.data) {
    toast('That game no longer exists', true);
    location.hash = '';
    return;
  }
  S.game = g.data;
  S.players = p.data ?? [];
  S.priv = pr.data;
  S.events = ev.data ?? [];
  S.messages = (msg.data ?? []).reverse();
  S.me = byId(S.user.id) ?? null;
  if (S.selected && !byId(S.selected)?.alive) S.selected = null;
  renderGame();
}

// ---------------------------------------------------------------- game: render
function renderGame() {
  const g = S.game;
  $('g-name').textContent = g.name;
  $('g-status').textContent = g.status;
  $('g-status').className = 'badge ' + g.status;
  $('g-tz').textContent = `5pm = ${g.timezone}`;

  const waiting = g.status === 'waiting';
  $('waiting').classList.toggle('hidden', !waiting);
  $('arena').classList.toggle('hidden', waiting);
  if (waiting) renderWaiting();
  else { renderBoard(); renderMe(); renderActions(); renderPlayers(); }

  const winner = byId(g.winner_id);
  $('winner').classList.toggle('hidden', g.status !== 'finished');
  $('winner').textContent = winner ? `🏆 ${winner.username} is the last tank standing!` : 'Game over';

  renderEvents();
  renderChat();
  tick();
}

function renderWaiting() {
  const isHost = S.game.host_id === S.user.id;
  $('wait-list').innerHTML = S.players.map((p) =>
    `<li>${esc(p.username)}${p.user_id === S.game.host_id ? ' <span class="muted small">(host)</span>' : ''}</li>`).join('');
  $('join-btn').classList.toggle('hidden', !!S.me);
  $('start-btn').classList.toggle('hidden', !isHost);
  $('start-btn').disabled = S.players.length < 2;
  $('leave-btn').classList.toggle('hidden', !S.me);
  $('leave-btn').textContent = isHost ? 'Delete lobby' : 'Leave lobby';
}

$('join-btn').onclick = () => joinGame(S.gameId);
$('start-btn').onclick = async () => {
  if (!confirm(`Start the game with ${S.players.length} players? Nobody else can join after this.`)) return;
  const { error } = await sb.rpc('start_game', { p_game: S.gameId });
  if (error) return toast(error.message, true);
  await syncAp();
  refreshGame();
};
$('leave-btn').onclick = async () => {
  const isHost = S.game.host_id === S.user.id;
  if (!confirm(isHost ? 'Delete this lobby for everyone?' : 'Leave this lobby?')) return;
  const { error } = await sb.rpc('leave_game', { p_game: S.gameId });
  if (error) return toast(error.message, true);
  location.hash = '';
};
$('copy-link').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); toast('Invite link copied'); }
  catch { prompt('Copy this link:', location.href); }
};

function renderBoard() {
  const g = S.game, n = g.board_size, me = S.me;
  const board = $('board');
  board.style.setProperty('--n', n);
  const occ = new Map();
  for (const p of S.players) if (p.alive && p.x != null) occ.set(p.x + ',' + p.y, p);
  const showRange = me?.alive && g.status === 'active';

  let html = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const p = occ.get(x + ',' + y);
      const cls = ['cell'];
      if (showRange && inRange(me, x, y)) cls.push('inrange');
      let inner = '';
      if (p) {
        if (p.user_id === S.user.id) cls.push('me');
        if (p.user_id === S.selected) cls.push('sel');
        inner = `<div class="tank" style="--h:${hue(p.username)}" data-uid="${p.user_id}"
          title="${esc(p.username)} · ${p.hp} HP · ${p.ap} AP · range ${p.reach}">
          <span>${esc(p.username.slice(0, 3))}</span><i>${'♥'.repeat(p.hp)}</i></div>`;
      }
      html += `<div class="${cls.join(' ')}">${inner}</div>`;
    }
  }
  board.innerHTML = html;
}

function selectTarget(uid) {
  if (!uid || uid === S.user.id || !byId(uid)?.alive) return;
  S.selected = S.selected === uid ? null : uid;
  renderGame();
}
$('board').addEventListener('click', (e) => selectTarget(e.target.closest('.tank')?.dataset.uid));
$('player-list').addEventListener('click', (e) => selectTarget(e.target.closest('li')?.dataset.uid));

function renderMe() {
  const me = S.me;
  if (!me) { $('me-panel').innerHTML = '<p class="muted">You are spectating this game.</p>'; return; }
  $('me-panel').innerHTML = `<h3>Your tank ${me.alive ? '' : '<span class="bad">— destroyed</span>'}</h3>
    <div class="stats">
      <div><b>${'♥'.repeat(me.hp) || '0'}</b><span>HP</span></div>
      <div><b>${me.ap}</b><span>AP</span></div>
      <div><b>${me.reach}</b><span>Range</span></div>
      <div><b>${me.alive ? `${me.x},${me.y}` : '–'}</b><span>Position</span></div>
    </div>`;
}

function moveBlocked(dir) {
  const n = S.game.board_size, me = S.me;
  let x = me.x, y = me.y;
  if (dir === 'up') y--; if (dir === 'down') y++; if (dir === 'left') x--; if (dir === 'right') x++;
  x = (x + n) % n; y = (y + n) % n;
  return S.players.some((p) => p.alive && p.x === x && p.y === y);
}

function renderActions() {
  const el = $('actions'), g = S.game, me = S.me;
  if (g.status !== 'active' || !me?.alive) {
    const why = !me ? 'Spectating.' : !me.alive ? 'Your tank has been destroyed.' : 'The game is over.';
    el.innerHTML = `<h3>Actions</h3><p class="muted">${why}</p>`;
    return;
  }
  const pen = penalty();
  S.lastPenalty = pen;
  const tgt = S.selected ? byId(S.selected) : null;
  const inR = tgt && inRange(me, tgt.x, tgt.y);
  const c1 = 1 + pen, ce = me.expand_cost + pen;
  const dis = (cost, extra = false) => (me.ap < cost || extra ? 'disabled' : '');
  const mv = (dir, label) =>
    `<button class="${dir}" data-move="${dir}" ${dis(c1, moveBlocked(dir))} title="Mobilise ${dir}">${label}</button>`;

  el.innerHTML = `
    <h3>Actions ${pen ? `<span class="warn">turn timer running: +${pen} AP each</span>` : ''}</h3>
    <div class="act-grid">
      <div class="dpad">
        ${mv('up', '▲')}${mv('left', '◀')}
        <div class="mid">Mobilise<br>${c1} AP</div>
        ${mv('right', '▶')}${mv('down', '▼')}
      </div>
      <div class="act-btns">
        <p class="target">${tgt
          ? `Target: <b>${esc(tgt.username)}</b> (${tgt.hp} HP, ${tgt.ap} AP) ${inR ? '<span class="ok">in range</span>' : '<span class="bad">out of range</span>'}`
          : '<span class="muted">Click a tank to target it.</span>'}</p>
        <button class="attack" data-act="attack" ${dis(c1, !inR)}>Attack · ${c1} AP</button>
        <button data-act="supply" ${dis(c1, !inR)}>Supply 1 AP · ${c1} AP</button>
        <button class="ghost" data-act="expand" ${dis(ce)}>Expand to range ${me.reach + 1} · ${ce} AP</button>
      </div>
    </div>`;
}

$('actions').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.move) doAction('move', { dir: b.dataset.move });
  else if (b.dataset.act) doAction(b.dataset.act, { target: b.dataset.act === 'expand' ? null : S.selected });
});

async function doAction(action, { dir = null, target = null } = {}) {
  const pen = penalty();
  const base = action === 'expand' ? S.me.expand_cost : 1;
  const cost = base + pen;
  const tgt = target ? byId(target) : null;
  if (pen > 0 && !confirm(`Your turn timer is still running, so this costs ${cost} AP instead of ${base}, and restarts the 30-minute timer. Continue?`)) return;
  if (action === 'attack' && !confirm(`Fire at ${tgt.username}?`)) return;
  if (action === 'expand' && !pen && !confirm(`Spend ${cost} AP to expand your range to ${S.me.reach + 1}?`)) return;

  const { error } = await sb.rpc('act', {
    p_game: S.gameId, p_action: action, p_target: target, p_dir: dir, p_max_cost: cost,
  });
  if (error) return toast(error.message, true);
  toast({ move: 'Moved', attack: 'Direct hit!', supply: `Sent 1 AP to ${tgt?.username}`, expand: 'Range expanded' }[action]);
  refreshGame();
}

function renderPlayers() {
  const list = [...S.players].sort((a, b) =>
    (b.alive - a.alive) || (a.user_id === S.user.id ? -1 : b.user_id === S.user.id ? 1 : a.username.localeCompare(b.username)));
  $('player-list').innerHTML = list.map((p) => {
    const cls = [!p.alive && 'dead', p.user_id === S.selected && 'sel'].filter(Boolean).join(' ');
    const near = p.alive && S.me?.alive && p.user_id !== S.user.id && inRange(S.me, p.x, p.y) ? ' <span class="ok small">in range</span>' : '';
    const meta = p.alive ? `${'♥'.repeat(p.hp)} · ${p.ap} AP · R${p.reach}` : 'destroyed';
    return `<li class="${cls}" data-uid="${p.user_id}">
      <span class="dot" style="--h:${hue(p.username)}"></span>
      <span>${esc(p.username)}${p.user_id === S.user.id ? ' <span class="muted small">(you)</span>' : ''}${near}</span>
      <span class="meta">${meta}</span></li>`;
  }).join('');
}

function renderEvents() {
  $('event-log').innerHTML = S.events.map((e) =>
    `<li><time>${fmtTime(e.created_at)}</time>${e.visible_to ? '🔒 ' : ''}${esc(e.body)}</li>`).join('')
    || '<li class="muted">Nothing yet.</li>';
}

// ---------------------------------------------------------------- chat
function renderChat() {
  const log = $('chat-log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = S.messages.map((m) => {
    const to = m.recipients
      ? ` <span class="muted small">→ ${m.recipients.map((r) => esc(byId(r)?.username ?? '?')).join(', ')}</span>` : '';
    return `<div class="msg ${m.recipients ? 'private' : ''}"><time>${fmtTime(m.created_at)}</time>
      <span class="who" style="color:hsl(${hue(m.sender_name)} 70% 65%)">${esc(m.sender_name)}</span>${to}: ${esc(m.body)}</div>`;
  }).join('') || '<p class="muted small">No messages yet.</p>';
  if (atBottom) log.scrollTop = log.scrollHeight;

  const others = S.players.filter((p) => p.user_id !== S.user.id);
  for (const uid of S.chatTo) if (!byId(uid)) S.chatTo.delete(uid);
  $('chat-to').innerHTML = `<span class="muted">To:</span>
    <button type="button" class="chip ${S.chatTo.size ? '' : 'on'}" data-all="1">Everyone</button>
    ${others.map((p) => `<button type="button" class="chip ${S.chatTo.has(p.user_id) ? 'on' : ''}" data-uid="${p.user_id}">${esc(p.username)}</button>`).join('')}`;
  $('chat-form').classList.toggle('hidden', !S.me);
}

$('chat-to').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  if (b.dataset.all) S.chatTo.clear();
  else if (S.chatTo.has(b.dataset.uid)) S.chatTo.delete(b.dataset.uid);
  else S.chatTo.add(b.dataset.uid);
  renderChat();
});

$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = $('chat-input').value.trim();
  if (!body) return;
  const { error } = await sb.rpc('send_message', {
    p_game: S.gameId, p_body: body, p_recipients: S.chatTo.size ? [...S.chatTo] : null,
  });
  if (error) return toast(error.message, true);
  $('chat-input').value = '';
  refreshGame();
});

// ---------------------------------------------------------------- clocks
function tick() {
  const g = S.game;
  if (!g) return;
  const apEl = $('clock-ap'), turnEl = $('clock-turn');

  if (g.status !== 'active') {
    apEl.textContent = '–';
  } else if (S.nextAp && S.nextAp - now() > 0) {
    apEl.textContent = fmtDuration(S.nextAp - now());
  } else {
    apEl.textContent = 'Arriving…';
    if (!S.syncing) syncAp().then(refreshGame);
  }

  const last = S.priv?.last_action_at ? new Date(S.priv.last_action_at).getTime() : 0;
  const rem = last + TURN_MS - now();
  if (!S.me?.alive || g.status !== 'active') {
    turnEl.textContent = '–'; turnEl.className = '';
  } else if (rem > 0) {
    turnEl.textContent = fmtDuration(rem); turnEl.className = 'cooling';
  } else {
    turnEl.textContent = 'Ready'; turnEl.className = 'ready';
  }

  // Re-draw costs the moment the turn timer runs out
  if (S.lastPenalty !== null && penalty() !== S.lastPenalty) renderActions();
}

let ticks = 0;
setInterval(() => {
  tick();
  // Safety net in case a live update is missed
  if (++ticks % 30 === 0 && S.gameId && document.visibilityState === 'visible') refreshGame();
}, 1000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.gameId) syncAp().then(refreshGame);
});
