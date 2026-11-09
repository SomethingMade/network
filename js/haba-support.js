/* =====================================================================
   haba-support.js  ·  Settings → Help & Support → Chat with a live agent
   Same Firebase project as the Haba Support dashboard.

   Renders into three Haba bottom-sheet overlays (add them to index.html):
     #support-list-overlay   #support-new-overlay   #support-chat-overlay
   Because they are ordinary `.bottom-sheet-overlay` elements, Haba's own
   back-button system closes them one level at a time (chat → list → app)
   instead of closing the app. If they are missing they are created on the
   fly (works, but the device back button will not be intercepted).

   Exports: openSupportChat({ auth, db, profile }), watchSupportUnread({ auth, db, onChange })
   ===================================================================== */
import { ref, onValue, push, update, serverTimestamp, increment } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";

const CATEGORIES = ['Account & login', 'Payments & coins', 'Verified badge', 'Rides', 'Messaging', 'Report abuse', 'Bug report', 'Other'];
const STATUS = { open: 'We’re on it', pending: 'Agent replied', resolved: 'Resolved' };
const IDS = { list: 'support-list-overlay', new: 'support-new-overlay', chat: 'support-chat-overlay' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (ts) => ts ? new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
const dayKey = (ts) => ts ? new Date(ts).toDateString() : '';
const dayLabel = (ts) => {
  const d = new Date(ts), n = new Date(), y = new Date(); y.setDate(n.getDate() - 1);
  if (d.toDateString() === n.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: d.getFullYear() === n.getFullYear() ? undefined : 'numeric' });
};
const short = (ts) => {
  if (!ts) return '';
  const d = new Date(ts), n = new Date();
  return d.toDateString() === n.toDateString() ? clock(ts) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

const I_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>';
const I_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
const I_HELP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';

/* ---------- unread watcher (badge on the Settings row) ---------- */
export function watchSupportUnread({ auth, db, onChange }) {
  const user = auth.currentUser; if (!user) return () => {};
  const per = {}, subs = {};
  const emit = () => onChange(Object.values(per).reduce((a, n) => a + (n > 0 ? n : 0), 0));   // unread agent messages
  const stopIdx = onValue(ref(db, 'support_user_tickets/' + user.uid), (snap) => {
    Object.keys(snap.val() || {}).forEach(id => {
      if (subs[id]) return;
      subs[id] = onValue(ref(db, 'support_tickets/' + id + '/unreadForUser'), s => { per[id] = s.val() || 0; emit(); });
    });
  });
  return () => { stopIdx(); Object.values(subs).forEach(u => u()); };
}

/* ---------- styles: use Haba's own theme variables (light/dark/accent follow the app) ---------- */
function injectStyles() {
  if (document.getElementById('hs-style')) return;
  const s = document.createElement('style'); s.id = 'hs-style';
  s.textContent = `
  .hs-screen{--s-bg:var(--bg-base,#fff);--s-surface:var(--bg-surface,#fff);--s-input:var(--bg-input,#F0F2F5);--s-hover:var(--bg-hover,#FAFAFA);--s-line:var(--border-color,#F0F0F0);
    --s-ink:var(--text-primary,#111);--s-mute:var(--text-secondary,#888);--s-brand:var(--primary-blue,#111);--s-on-brand:#fff;
    width:100%;height:100%;display:flex;flex-direction:column;background:var(--s-bg);color:var(--s-ink);
    transform:translateY(100%);transition:transform .32s var(--ease-smooth,cubic-bezier(.16,1,.3,1));font-size:15px;line-height:1.4}
  .bottom-sheet-overlay.active > .hs-screen{transform:translateY(0)}
  .hs-screen *{box-sizing:border-box}
  .hs-screen button,.hs-screen input,.hs-screen select,.hs-screen textarea{font:inherit;color:inherit}
  .hs-head{display:flex;align-items:center;gap:10px;background:var(--s-surface);border-bottom:1px solid var(--s-line);padding:calc(10px + min(env(safe-area-inset-top),20px)) 10px 10px;flex-shrink:0}
  .hs-back{width:38px;height:38px;border:0;border-radius:50%;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0}
  .hs-back:active{background:var(--s-hover)} .hs-back svg{width:22px;height:22px}
  .hs-ava{width:38px;height:38px;border-radius:50%;background:var(--s-brand);color:var(--s-on-brand);display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .hs-ava svg{width:19px;height:19px}
  .hs-ttl{flex:1;min-width:0}.hs-ttl b{display:block;font-size:16.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hs-ttl small{display:block;font-size:12.5px;color:var(--s-mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hs-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
  .hs-foot{padding:10px 14px calc(10px + env(safe-area-inset-bottom));background:var(--s-surface);border-top:1px solid var(--s-line);flex-shrink:0}
  .hs-pill{width:100%;border:0;border-radius:var(--radius-pill,50px);background:var(--s-brand);color:var(--s-on-brand);padding:13px 18px;font-weight:700;cursor:pointer}
  .hs-pill:active{transform:scale(.98)}.hs-pill:disabled{opacity:.5}
  /* conversation list */
  .hs-row{display:flex;gap:12px;align-items:center;width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid var(--s-line);padding:13px 16px;cursor:pointer}
  .hs-row:active{background:var(--s-hover)}
  .hs-row .g{flex:1;min-width:0}.hs-row .l1{display:flex;justify-content:space-between;gap:8px}
  .hs-row b{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hs-row .tm{color:var(--s-mute);font-size:12px;white-space:nowrap}
  .hs-row .pv{color:var(--s-mute);font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
  .hs-row .l2{display:flex;align-items:center;gap:8px;margin-top:2px}
  .hs-badge{min-width:20px;height:20px;border-radius:10px;background:var(--s-brand);color:var(--s-on-brand);font-size:11.5px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;padding:0 6px}
  .hs-st{font-size:12px;color:var(--s-mute);margin-top:2px}
  .hs-empty{text-align:center;color:var(--s-mute);padding:64px 28px}
  .hs-empty .ic{width:64px;height:64px;border-radius:50%;background:var(--s-input);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;color:var(--s-ink)}
  .hs-empty .ic svg{width:28px;height:28px}.hs-empty h3{margin:0 0 6px;color:var(--s-ink);font-size:18px}
  /* new conversation form */
  .hs-form{padding:18px 18px 24px}
  .hs-form label{display:block;font-size:12.5px;font-weight:700;color:var(--s-mute);margin:16px 0 6px}
  .hs-form input,.hs-form select,.hs-form textarea{width:100%;padding:12px 14px;border:1px solid var(--s-line);border-radius:14px;background:var(--s-input);outline:none}
  .hs-form input:focus,.hs-form select:focus,.hs-form textarea:focus{border-color:var(--s-brand)}
  .hs-form textarea{min-height:130px;resize:vertical}
  .hs-err{color:var(--danger-red,#FF453A);font-size:13px;min-height:18px;margin-top:10px}
  /* conversation: bubbles use Haba's message colours & shape */
  .hs-msgs{display:flex;flex-direction:column;gap:6px;padding:14px 12px 10px;min-height:100%;justify-content:flex-end}
  .hs-day{align-self:center;margin:6px 0 4px}
  .hs-day span{display:block;background:var(--s-hover);color:var(--s-mute);font-size:12px;font-weight:600;padding:5px 14px;border-radius:14px;box-shadow:var(--shadow-bubble,0 1px 1px rgba(0,0,0,.1))}
  .hs-bub{max-width:76%;padding:9px 14px 7px;border-radius:22px;font-size:15px;line-height:1.42;word-break:break-word;flex-shrink:0;animation:hsIn .18s ease}
  .hs-bub .t{white-space:pre-wrap}
  .hs-bub .m{display:block;text-align:right;font-size:11px;margin-top:3px}
  .hs-bub.in{align-self:flex-start;background:var(--msg-in-bg,#fff);color:var(--msg-in-text,#111);border-bottom-left-radius:6px;box-shadow:var(--shadow-bubble,0 1px 1px rgba(0,0,0,.1))}
  .hs-bub.in .m{color:var(--msg-in-time,rgba(0,0,0,.45))}
  .hs-bub.out{align-self:flex-end;background:var(--msg-out-bg,#111);color:var(--msg-out-text,#fff);border-bottom-right-radius:6px;box-shadow:var(--shadow-bubble-out,0 2px 6px rgba(0,0,0,.2))}
  .hs-bub.out .m{color:var(--msg-out-time,rgba(255,255,255,.8))}
  .hs-who{align-self:flex-start;font-size:12px;color:var(--s-mute);margin:2px 0 -2px 10px}
  .hs-sys{align-self:center;font-size:12.5px;color:var(--s-mute);padding:3px 12px;background:var(--s-hover);border-radius:14px;text-align:center}
  @keyframes hsIn{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
  .hs-rate{align-self:stretch;text-align:center;margin:10px 4px 4px;padding:14px;background:var(--s-surface);border:1px solid var(--s-line);border-radius:18px;font-size:14px}
  .hs-rate button{border:0;background:none;font-size:30px;line-height:1;color:#F5B301;padding:2px 3px;cursor:pointer}
  .hs-rate small{display:block;color:var(--s-mute);margin-top:4px}
  .hs-comp{display:flex;gap:10px;align-items:flex-end}
  .hs-comp textarea{flex:1;min-height:44px;max-height:130px;resize:none;border:1px solid var(--s-line);background:var(--s-input);border-radius:22px;padding:11px 16px;outline:none;line-height:1.35}
  .hs-send{width:44px;height:44px;border-radius:50%;border:0;background:var(--s-brand);color:var(--s-on-brand);display:flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer}
  .hs-send:active{transform:scale(.92)}.hs-send svg{width:19px;height:19px}`;
  document.head.appendChild(s);
}

function getOverlay(key) {
  let el = document.getElementById(IDS[key]);
  if (!el) { el = document.createElement('div'); el.id = IDS[key]; el.className = 'bottom-sheet-overlay'; document.body.appendChild(el); }
  el.style.zIndex = '100020';            // above Haba's Settings (100010) and Help sheet (100012)
  el.style.alignItems = 'stretch';
  el.style.background = 'transparent';
  el.style.backdropFilter = 'none';
  return el;
}

/* ---------- main entry ---------- */
export function openSupportChat({ auth, db, profile = {}, onClose } = {}) {
  injectStyles();
  const user = auth.currentUser;
  if (!user) throw new Error('openSupportChat: user must be signed in');
  const me = { uid: user.uid, name: profile.name || user.displayName || 'Haba user', photo: profile.photoURL || user.photoURL || '', phone: profile.phoneNumber || user.phoneNumber || '' };

  const ov = { list: getOverlay('list'), new: getOverlay('new'), chat: getOverlay('chat') };
  if (ov.list.classList.contains('active')) return;

  const tickets = {}, tSubs = {};
  let stopIndex = null, stopMsgs = null, openId = null, msgs = [], closed = false;
  const observers = [];

  const open = (k) => requestAnimationFrame(() => ov[k].classList.add('active'));   // lets the slide-in animate
  const close = (k) => ov[k].classList.remove('active');                              // Haba's history system pops its entry

  function teardown() {
    if (closed) return; closed = true;
    if (stopIndex) stopIndex(); if (stopMsgs) stopMsgs();
    Object.values(tSubs).forEach(u => u());
    observers.forEach(o => o.disconnect());
    document.removeEventListener('keydown', onKey);
    ['chat', 'new', 'list'].forEach(close);
    if (onClose) onClose();
  }
  function watchClose(k, fn) {
    const o = new MutationObserver(() => { if (!ov[k].classList.contains('active')) fn(); });
    o.observe(ov[k], { attributes: true, attributeFilter: ['class'] }); observers.push(o);
  }
  watchClose('list', teardown);                                   // leaving the list = leaving support
  watchClose('chat', () => { if (stopMsgs) { stopMsgs(); stopMsgs = null; } openId = null; });
  const onKey = (e) => { if (e.key === 'Escape') { for (const k of ['chat', 'new', 'list']) if (ov[k].classList.contains('active')) { close(k); break; } } };
  document.addEventListener('keydown', onKey);

  const header = (backKey, title, sub) => `
    <div class="hs-head"><button class="hs-back" data-close="${backKey}" aria-label="Back">${I_BACK}</button>
      <span class="hs-ava">${I_HELP}</span><div class="hs-ttl"><b>${esc(title)}</b><small>${esc(sub || '')}</small></div></div>`;

  /* ----- list ----- */
  function renderList() {
    ov.list.innerHTML = `<div class="hs-screen">${header('list', 'Haba Support', 'Chat with a live agent')}
      <div class="hs-body" id="hs-list"></div>
      <div class="hs-foot"><button class="hs-pill" data-new>New conversation</button></div></div>`;
    drawList();
  }
  function drawList() {
    const box = ov.list.querySelector('#hs-list'); if (!box) return;
    const list = Object.values(tickets).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    box.innerHTML = list.length ? list.map(t => `
      <button class="hs-row" data-open="${t.id}"><span class="hs-ava">${I_HELP}</span>
        <div class="g"><div class="l1"><b>${esc(t.subject || 'Conversation')}</b><span class="tm">${short(t.updatedAt)}</span></div>
          <div class="l2"><span class="pv">${t.lastSender === 'user' ? 'You: ' : ''}${esc(t.lastMessage || '')}</span>${t.unreadForUser > 0 ? `<span class="hs-badge">${t.unreadForUser}</span>` : ''}</div>
          <div class="hs-st">${esc(STATUS[t.status] || t.status || '')}</div></div></button>`).join('')
      : `<div class="hs-empty"><div class="ic">${I_HELP}</div><h3>Need a hand?</h3>Start a conversation and a Haba agent will reply here.</div>`;
  }

  /* ----- new conversation ----- */
  function renderNew() {
    ov.new.innerHTML = `<div class="hs-screen">${header('new', 'New conversation', 'Tell us what you need')}
      <div class="hs-body"><div class="hs-form">
        <label for="hs-cat">What’s this about?</label>
        <select id="hs-cat">${CATEGORIES.map(c => `<option>${esc(c)}</option>`).join('')}</select>
        <label for="hs-sub">Subject</label>
        <input id="hs-sub" maxlength="100" placeholder="e.g. My badge payment didn’t go through">
        <label for="hs-msg">What happened?</label>
        <textarea id="hs-msg" maxlength="2000" placeholder="Include any details that help us find your account or payment."></textarea>
        <div class="hs-err" id="hs-err"></div>
      </div></div>
      <div class="hs-foot"><button class="hs-pill" data-create>Send to an agent</button></div></div>`;
    open('new');
  }
  async function createTicket(btn) {
    const subject = ov.new.querySelector('#hs-sub').value.trim(), text = ov.new.querySelector('#hs-msg').value.trim();
    const err = ov.new.querySelector('#hs-err');
    if (!subject) { err.textContent = 'Add a short subject.'; return; }
    if (!text) { err.textContent = 'Describe what you need help with.'; return; }
    btn.disabled = true; err.textContent = '';
    const tid = push(ref(db, 'support_tickets')).key;
    try {
      await update(ref(db), {
        [`support_tickets/${tid}`]: {
          uid: me.uid, userName: me.name, userPhoto: me.photo, userPhone: me.phone,
          subject, category: ov.new.querySelector('#hs-cat').value, priority: 'normal', status: 'open', source: 'user',
          createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
          lastMessage: text.slice(0, 140), lastSender: 'user', unreadForAgent: 1, unreadForUser: 0
        },
        [`support_user_tickets/${me.uid}/${tid}`]: true
      });
      await update(ref(db, `support_messages/${tid}`), {
        [push(ref(db, `support_messages/${tid}`)).key]: { text, sender: 'user', senderUid: me.uid, createdAt: serverTimestamp() }
      });
      close('new'); showChat(tid);
    } catch (e) { console.error(e); err.textContent = 'Couldn’t send. Check your connection and try again.'; btn.disabled = false; }
  }

  /* ----- conversation ----- */
  function showChat(tid) {
    openId = tid; msgs = [];
    const t = tickets[tid] || {};
    ov.chat.innerHTML = `<div class="hs-screen">${header('chat', t.subject || 'Conversation', STATUS[t.status] || 'Haba Support')}
      <div class="hs-body" id="hs-chat"><div class="hs-msgs" id="hs-msgs"></div></div>
      <div class="hs-foot"><div class="hs-comp"><textarea id="hs-in" rows="1" placeholder="Message"></textarea>
        <button class="hs-send" data-send aria-label="Send">${I_SEND}</button></div></div></div>`;
    const ta = ov.chat.querySelector('#hs-in');
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(130, ta.scrollHeight) + 'px'; });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer:coarse)').matches) { e.preventDefault(); send(); } });
    if (stopMsgs) stopMsgs();
    stopMsgs = onValue(ref(db, 'support_messages/' + tid), (snap) => {
      msgs = []; snap.forEach(c => msgs.push({ id: c.key, ...c.val() }));
      drawChat(); markRead();
    });
    drawChat(); open('chat');
  }
  function drawChat() {
    const t = tickets[openId]; if (!t) return;
    const head = ov.chat.querySelector('.hs-ttl');
    if (head) head.innerHTML = `<b>${esc(t.subject || 'Conversation')}</b><small>${esc(STATUS[t.status] || '')}</small>`;
    const box = ov.chat.querySelector('#hs-msgs'), wrap = ov.chat.querySelector('#hs-chat'); if (!box) return;
    const near = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 160;
    let lastDay = '', lastWho = '';
    const html = msgs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map(m => {
      let out = '';
      const dk = dayKey(m.createdAt);
      if (dk && dk !== lastDay) { out += `<div class="hs-day"><span>${esc(dayLabel(m.createdAt))}</span></div>`; lastDay = dk; lastWho = ''; }
      if (m.sender === 'system') { lastWho = ''; return out + `<div class="hs-sys">${esc(m.text)}</div>`; }
      const mine = m.sender === 'user';
      const who = mine ? 'me' : (m.senderName || 'Haba Support');
      if (!mine && who !== lastWho) out += `<span class="hs-who">${esc(who)}</span>`;
      lastWho = who;
      return out + `<div class="hs-bub ${mine ? 'out' : 'in'}"><span class="t">${esc(m.text)}</span><span class="m">${clock(m.createdAt)}</span></div>`;
    }).join('');
    let rate = '';
    if (t.status === 'resolved') {
      const r = typeof t.rating === 'number' ? t.rating : 0;
      rate = `<div class="hs-rate">${r ? 'Thanks for rating us.' : 'How did we do?'}<br>${[1, 2, 3, 4, 5].map(n => `<button data-rate="${n}" aria-label="${n} stars">${n <= r ? '★' : '☆'}</button>`).join('')}<small>Reply below to reopen this conversation.</small></div>`;
    }
    box.innerHTML = html + rate;
    if (near || !box.dataset.init) { wrap.scrollTop = wrap.scrollHeight; box.dataset.init = '1'; }
  }
  function markRead() {
    const t = tickets[openId];
    if (t && t.unreadForUser > 0) update(ref(db, `support_tickets/${openId}`), { unreadForUser: 0 }).catch(() => {});
  }
  async function send() {
    const ta = ov.chat.querySelector('#hs-in'); if (!ta || !openId) return;
    const text = ta.value.trim(); if (!text) return;
    const tid = openId, mid = push(ref(db, `support_messages/${tid}`)).key;
    ta.value = ''; ta.style.height = 'auto';
    try {
      await update(ref(db), {
        [`support_messages/${tid}/${mid}`]: { text, sender: 'user', senderUid: me.uid, createdAt: serverTimestamp() },
        [`support_tickets/${tid}/lastMessage`]: text.slice(0, 140),
        [`support_tickets/${tid}/lastSender`]: 'user',
        [`support_tickets/${tid}/updatedAt`]: serverTimestamp(),
        [`support_tickets/${tid}/unreadForAgent`]: increment(1),
        [`support_tickets/${tid}/unreadForUser`]: 0,
        [`support_tickets/${tid}/status`]: 'open',        // reopens a resolved ticket and puts it back in the agents' queue
        [`support_tickets/${tid}/resolvedAt`]: null
      });
    } catch (e) { console.error(e); ta.value = text; alert('Message not sent. Check your connection and try again.'); }
  }

  /* ----- events ----- */
  const onClick = (e) => {
    const c = e.target.closest('[data-close]'), o = e.target.closest('[data-open]'), r = e.target.closest('[data-rate]');
    if (c) { close(c.dataset.close); return; }
    if (o) { showChat(o.dataset.open); return; }
    if (e.target.closest('[data-new]')) { renderNew(); return; }
    if (e.target.closest('[data-send]')) { send(); return; }
    const cr = e.target.closest('[data-create]'); if (cr) { createTicket(cr); return; }
    if (r && openId) update(ref(db, `support_tickets/${openId}`), { rating: +r.dataset.rate }).catch(() => {});
  };
  Object.values(ov).forEach(el => el.addEventListener('click', onClick));
  observers.push({ disconnect: () => Object.values(ov).forEach(el => el.removeEventListener('click', onClick)) });

  /* ----- live data: my tickets ----- */
  stopIndex = onValue(ref(db, 'support_user_tickets/' + me.uid), (snap) => {
    Object.keys(snap.val() || {}).forEach(id => {
      if (tSubs[id]) return;
      tSubs[id] = onValue(ref(db, 'support_tickets/' + id), (s) => {
        if (s.exists()) tickets[id] = { id, ...s.val() }; else delete tickets[id];
        if (openId === id) { drawChat(); markRead(); } else drawList();
      });
    });
  });

  renderList(); open('list');
  return teardown;
}
