import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Usernames are turned into a dummy email so Supabase's password login can be used.
const EMAIL_DOMAIN = 'players.alliance.game';

const CLASSES = {
  bunker:       { name: 'Bunker',       icon: '🛡️', desc: () => '+1 HP.' },
  skirmisher:   { name: 'Skirmisher',   icon: '💨', desc: () => 'Moving costs 1 less turn-timer surcharge (2 quick moves = 1+1, 3 = 4 AP total).' },
  blitz:        { name: 'Blitz',        icon: '⚡', desc: () => 'Start with +1 AP.' },
  overclock:    { name: 'Overclock',    icon: '⏱️', desc: (g) => `Shorter turn timer: ${fmtMinutes((g?.turn_minutes ?? 30) * 5 / 6)} instead of ${g?.turn_minutes ?? 30} min.` },
  artillery:    { name: 'Artillery',    icon: '🎯', desc: () => '+1 range, but cannot shoot the 4 squares directly touching you.' },
  medic:        { name: 'Medic',        icon: '➕', desc: () => 'Repair: 2 AP (+1 each use) restores 1 HP to you or a tank in range (up to its starting HP).' },
  sharpshooter: { name: 'Sharpshooter', icon: '🔭', desc: () => 'Each shot has a 1 in 6 chance to deal 2 damage.' },
};

const configured = !SUPABASE_URL.includes('YOUR-') && !SUPABASE_ANON_KEY.includes('YOUR-');
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const S = {
  user: null, username: null,
  gameId: null, game: null, players: [], me: null, priv: null,
  events: [], messages: [],
  nextAp: null, clockOffset: 0, syncing: false,
  selected: null, chatTo: new Set(), settingsDirty: false,
  channel: null, refreshTimer: null, lastPenalty: null, lobbyTimer: null,
};

// ---------------------------------------------------------------- utils
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now() + S.clockOffset;
const byId = (uid) => S.players.find((p) => p.user_id === uid);
const hearts = (hp) => (hp <= 4 ? '♥'.repeat(Math.max(0, hp)) : `${hp}♥`);
const classLabel = (k) => (CLASSES[k] ? `${CLASSES[k].icon} ${CLASSES[k].name}` : '');

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
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (d) return `${d}d ${h}h ${pad(m)}m`;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function fmtMinutes(mins) {
  const s = Math.round(mins * 60);
  return s % 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s / 60} min`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function scheduleText(g) {
  const m = g.ap_interval_minutes, t = g.ap_time.slice(0, 5);
  const every = m % 1440 === 0 ? (m === 1440 ? 'every day' : `every ${m / 1440} days`)
    : m % 60 === 0 ? (m === 60 ? 'every hour' : `every ${m / 60} hours`)
    : `every ${m} min`;
  return `+${g.ap_amount} AP ${every} ${m % 1440 === 0 ? 'at' : 'from'} ${t} (${g.timezone})`;
}

function hue(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function wrapDelta(a, b) {
  const n = S.game.board_size, d = Math.abs(a - b);
  return Math.min(d, n - d);
}

function inRange(from, x, y) {
  if (from?.x == null || x == null) return false;
  const dx = wrapDelta(from.x, x), dy = wrapDelta(from.y, y);
  return dx * dx + dy * dy <= from.reach * from.reach;
}

const adjacent = (a, b) => wrapDelta(a.x, b.x) + wrapDelta(a.y, b.y) === 1;

// ---------------------------------------------------------------- costs
function turnMs() {
  return (S.priv?.turn_seconds ?? (S.game?.turn_minutes ?? 30) * 60) * 1000;
}

// Extra AP owed because the turn timer is still running.
function penalty() {
  const p = S.priv;
  if (!p?.last_action_at) return 0;
  return now() - new Date(p.last_action_at).getTime() < turnMs() ? p.streak : 0;
}

function costOf(action, pen = penalty()) {
  const me = S.me;
  switch (action) {
    case 'move':   return 1 + (me.tank_class === 'skirmisher' ? Math.max(0, pen - 1) : pen);
    case 'expand': return me.expand_cost + pen;
    case 'heal':   return me.heal_cost + pen;
    default:       return 1 + pen;
  }
}

// ---------------------------------------------------------------- static setup
for (const id of ['rules-auth', 'rules-lobby']) {
  $(id).innerHTML = $('rules-tpl').innerHTML;
  $(id).querySelector('.class-rules').innerHTML = Object.values(CLASSES)
    .map((c) => `<li><b>${c.icon} ${c.name}</b>: ${esc(c.desc(null))}</li>`).join('');
}

const myTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [myTz, 'UTC'];
const tzOptions = zones.map((z) => `<option>${esc(z)}</option>`).join('');
$('create-tz').innerHTML = tzOptions;
$('create-tz').value = myTz;
$('settings-tz').innerHTML = tzOptions;

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
async function openLobby() {
  show('lobby');
  clearInterval(S.lobbyTimer);
  S.lobbyTimer = setInterval(() => { if (!S.gameId && S.user) loadLobby(); }, 15000);
  loadLobby();
}

async function loadLobby() {
  const { data, error } = await sb.from('games')
    .select('id,name,status,host_id,timezone,classes_enabled,created_at,winner_id,players(user_id,username,alive)')
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
    <div><b>${esc(g.name)}</b><span class="muted small">Host ${esc(host)} · ${info}${g.classes_enabled ? ' · classes' : ''}</span></div>
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
    p_name: $('create-name').value.trim(), p_timezone: $('create-tz').value,
    p_classes: $('create-classes').checked,
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
  S.settingsDirty = false;
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

// Asks the server to hand out any AP drops that are due, and learns the next one.
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
  const wasWaiting = S.game?.status === 'waiting';
  S.game = g.data;
  S.players = p.data ?? [];
  S.priv = pr.data;
  S.events = ev.data ?? [];
  S.messages = (msg.data ?? []).reverse();
  S.me = byId(S.user.id) ?? null;
  if (S.selected && !byId(S.selected)?.alive) S.selected = null;
  if (wasWaiting && S.game.status === 'active') syncAp();
  renderGame();
}

// ---------------------------------------------------------------- game: render
function renderGame() {
  const g = S.game;
  $('g-name').textContent = g.name;
  $('g-status').textContent = g.status;
  $('g-status').className = 'badge ' + g.status;
  $('g-tz').textContent = `${scheduleText(g)} · ${g.turn_minutes}-min turn timer`
    + (g.classes_enabled ? ' · classes on' : '');

  const waiting = g.status === 'waiting';
  $('waiting').classList.toggle('hidden', !waiting);
  $('arena').classList.toggle('hidden', waiting);
  if (waiting) { renderWaiting(); renderSettings(); renderClassPicker(); }
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
  if (S.settingsDirty && !confirm('You have unsaved settings changes. Start anyway with the saved settings?')) return;
  if (!confirm(`Start the game with ${S.players.length} players? Nobody else can join and settings are locked after this.`)) return;
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

// ---------------------------------------------------------------- lobby settings
const NUM_SETTINGS = ['board_size', 'start_hp', 'start_ap', 'start_range', 'expand_base', 'turn_minutes', 'ap_amount'];

function renderSettings() {
  const f = $('settings-form'), g = S.game, isHost = g.host_id === S.user.id;
  for (const el of f.elements) el.disabled = !isHost;
  $('settings-save').classList.toggle('hidden', !isHost);
  $('settings-note').textContent = isHost ? '' : '(set by the host)';
  if (isHost && S.settingsDirty) return; // don't overwrite the host's unsaved edits

  const el = f.elements;
  for (const k of NUM_SETTINGS) el[k].value = g[k];
  const m = g.ap_interval_minutes, unit = m % 1440 === 0 ? 1440 : m % 60 === 0 ? 60 : 1;
  el.ap_unit.value = String(unit);
  el.ap_every.value = m / unit;
  el.ap_time.value = g.ap_time.slice(0, 5);
  if (![...el.timezone.options].some((o) => o.value === g.timezone)) {
    el.timezone.insertAdjacentHTML('afterbegin', `<option>${esc(g.timezone)}</option>`);
  }
  el.timezone.value = g.timezone;
  el.classes_enabled.checked = g.classes_enabled;
}

$('settings-form').addEventListener('input', () => (S.settingsDirty = true));
$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = e.target.elements;
  const p = {};
  for (const k of NUM_SETTINGS) p[k] = parseInt(el[k].value, 10);
  p.ap_interval_minutes = parseInt(el.ap_every.value, 10) * parseInt(el.ap_unit.value, 10);
  p.ap_time = el.ap_time.value || '17:00';
  p.timezone = el.timezone.value;
  p.classes_enabled = el.classes_enabled.checked;
  if (Object.values(p).some((v) => typeof v === 'number' && Number.isNaN(v))) return toast('Fill in every setting', true);
  if (p.ap_interval_minutes < 5 || p.ap_interval_minutes > 10080) return toast('AP interval must be between 5 minutes and 7 days', true);

  const { error } = await sb.rpc('update_settings', { p_game: S.gameId, p });
  if (error) return toast(error.message, true);
  S.settingsDirty = false;
  toast('Settings saved');
  refreshGame();
});

function renderClassPicker() {
  const visible = S.game.classes_enabled && !!S.me;
  $('class-panel').classList.toggle('hidden', !visible);
  if (!visible) return;
  const mine = S.priv?.chosen_class ?? '';
  const card = (key, title, desc) =>
    `<button type="button" class="class-card ${mine === key ? 'on' : ''}" data-class="${key}"><b>${title}</b><span>${esc(desc)}</span></button>`;
  $('class-list').innerHTML =
    Object.entries(CLASSES).map(([k, c]) => card(k, `${c.icon} ${c.name}`, c.desc(S.game))).join('')
    + card('', '🎲 Random', 'Get a random class when the game starts.');
}

$('class-list').addEventListener('click', async (e) => {
  const b = e.target.closest('.class-card');
  if (!b) return;
  const { error } = await sb.rpc('choose_class', { p_game: S.gameId, p_class: b.dataset.class || null });
  if (error) return toast(error.message, true);
  toast(b.dataset.class ? `You'll play as ${CLASSES[b.dataset.class].name}` : 'Random class selected');
  refreshGame();
});

// ---------------------------------------------------------------- board & panels
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
        const klass = p.tank_class ? ` · ${CLASSES[p.tank_class]?.name}` : '';
        inner = `<div class="tank" style="--h:${hue(p.username)}" data-uid="${p.user_id}"
          title="${esc(p.username)}${klass} · ${p.hp}/${p.max_hp} HP · ${p.ap} AP · range ${p.reach}">
          <span>${esc(p.username.slice(0, 3))}</span><i>${hearts(p.hp)}</i></div>`;
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
  const klass = me.tank_class
    ? `<p class="small" style="margin:8px 0 0"><b>${classLabel(me.tank_class)}</b> <span class="muted">${esc(CLASSES[me.tank_class].desc(S.game))}</span></p>` : '';
  $('me-panel').innerHTML = `<h3>Your tank ${me.alive ? '' : '<span class="bad">— destroyed</span>'}</h3>
    <div class="stats">
      <div><b>${me.hp}/${me.max_hp}</b><span>HP</span></div>
      <div><b>${me.ap}</b><span>AP</span></div>
      <div><b>${me.reach}</b><span>Range</span></div>
      <div><b>${me.alive ? `${me.x},${me.y}` : '–'}</b><span>Position</span></div>
    </div>${klass}`;
}

function moveBlocked(dir) {
  const n = S.game.board_size, me = S.me;
  let x = me.x, y = me.y;
  if (dir === 'up') y--;
  if (dir === 'down') y++;
  if (dir === 'left') x--;
  if (dir === 'right') x++;
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
  const tooClose = me.tank_class === 'artillery' && tgt && adjacent(me, tgt);
  const cMove = costOf('move', pen), c1 = costOf('attack', pen), ce = costOf('expand', pen), ch = costOf('heal', pen);
  const dis = (cost, blocked = false) => (me.ap < cost || blocked ? 'disabled' : '');
  const mv = (dir, label) =>
    `<button class="${dir}" data-move="${dir}" ${dis(cMove, moveBlocked(dir))} title="Mobilise ${dir}">${label}</button>`;

  let status = '<span class="muted">Click a tank to target it.</span>';
  if (tgt) {
    const where = !inR ? '<span class="bad">out of range</span>'
      : tooClose ? '<span class="warn">too close for artillery fire</span>' : '<span class="ok">in range</span>';
    status = `Target: <b>${esc(tgt.username)}</b> (${tgt.hp}/${tgt.max_hp} HP, ${tgt.ap} AP) ${where}`;
  }

  const medic = me.tank_class === 'medic' ? `
    <button class="ghost" data-act="heal-self" ${dis(ch, me.hp >= me.max_hp)}>Repair yourself · ${ch} AP</button>
    <button class="ghost" data-act="heal" ${dis(ch, !inR || !tgt || tgt.hp >= tgt.max_hp)}>Repair target · ${ch} AP</button>` : '';

  el.innerHTML = `
    <h3>Actions ${pen ? `<span class="warn">turn timer running: +${pen} AP surcharge</span>` : ''}</h3>
    <div class="act-grid">
      <div class="dpad">
        ${mv('up', '▲')}${mv('left', '◀')}
        <div class="mid">Mobilise<br>${cMove} AP</div>
        ${mv('right', '▶')}${mv('down', '▼')}
      </div>
      <div class="act-btns">
        <p class="target">${status}</p>
        <button class="attack" data-act="attack" ${dis(c1, !inR || tooClose)}>Attack · ${c1} AP</button>
        <button data-act="supply" ${dis(c1, !inR)}>Supply 1 AP · ${c1} AP</button>
        <button class="ghost" data-act="expand" ${dis(ce)}>Expand to range ${me.reach + 1} · ${ce} AP</button>
        ${medic}
      </div>
    </div>`;
}

$('actions').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  if (b.dataset.move) doAction('move', { dir: b.dataset.move });
  else if (act === 'expand') doAction('expand');
  else if (act === 'heal-self') doAction('heal', { target: S.user.id });
  else if (act) doAction(act, { target: S.selected });
});

async function doAction(action, { dir = null, target = null } = {}) {
  const pen = penalty();
  const base = costOf(action, 0);
  const cost = costOf(action, pen);
  const tgt = target ? byId(target) : null;
  if (cost > base && !confirm(`Your turn timer is still running, so this costs ${cost} AP instead of ${base}, and restarts the timer. Continue?`)) return;
  if (action === 'attack' && !confirm(`Fire at ${tgt.username}?`)) return;
  if (action === 'expand' && cost === base && !confirm(`Spend ${cost} AP to expand your range to ${S.me.reach + 1}?`)) return;

  const { error } = await sb.rpc('act', {
    p_game: S.gameId, p_action: action, p_target: target, p_dir: dir, p_max_cost: cost,
  });
  if (error) return toast(error.message, true);
  toast({
    move: 'Moved', attack: 'Shot fired!', supply: `Sent 1 AP to ${tgt?.username}`,
    expand: 'Range expanded', heal: target === S.user.id ? 'Repaired yourself' : `Repaired ${tgt?.username}`,
  }[action]);
  refreshGame();
}

function renderPlayers() {
  const list = [...S.players].sort((a, b) =>
    (b.alive - a.alive) || (a.user_id === S.user.id ? -1 : b.user_id === S.user.id ? 1 : a.username.localeCompare(b.username)));
  $('player-list').innerHTML = list.map((p) => {
    const cls = [!p.alive && 'dead', p.user_id === S.selected && 'sel'].filter(Boolean).join(' ');
    const near = p.alive && S.me?.alive && p.user_id !== S.user.id && inRange(S.me, p.x, p.y) ? ' <span class="ok small">in range</span>' : '';
    const klass = p.tank_class ? `<span class="class-tag">${classLabel(p.tank_class)}</span>` : '';
    const meta = p.alive ? `${hearts(p.hp)} · ${p.ap} AP · R${p.reach}` : 'destroyed';
    return `<li class="${cls}" data-uid="${p.user_id}">
      <span class="dot" style="--h:${hue(p.username)}"></span>
      <span>${esc(p.username)}${p.user_id === S.user.id ? ' <span class="muted small">(you)</span>' : ''}${klass}${near}</span>
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
  const rem = last + turnMs() - now();
  if (!S.me?.alive || g.status !== 'active') {
    turnEl.textContent = '–'; turnEl.className = '';
  } else if (rem > 0) {
    turnEl.textContent = fmtDuration(rem); turnEl.className = 'cooling';
  } else {
    turnEl.textContent = 'Ready'; turnEl.className = 'ready';
  }

  // Re-draw costs the moment the turn timer runs out
  if (S.lastPenalty !== null && S.me?.alive && penalty() !== S.lastPenalty) renderActions();
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
