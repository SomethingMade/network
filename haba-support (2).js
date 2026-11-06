/* =====================================================================
   haba-support.js  ·  Settings → Help & Support → Chat with an agent
   Talks to the Haba Support dashboard through the SAME Firebase project.

   Usage (inside the Haba app, after the user is signed in):

     import { openSupportChat, watchSupportUnread } from './haba-support.js';

     // 1) open the chat from the "Help & Support" row in Settings
     settingsRow.onclick = () => openSupportChat({ auth, db, profile: currentUserProfile });

     // 2) optional: show a dot / count on that row when an agent has replied
     const stop = watchSupportUnread({ auth, db, onChange: n => badge.textContent = n || '' });

   `auth` and `db` are your existing getAuth(app) / getDatabase(app) instances.
   `profile` is optional: { name, photoURL, phoneNumber } from /users/{uid}.
   ===================================================================== */
import { ref, onValue, push, update, serverTimestamp, increment } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";

const CATEGORIES = ['Account & login', 'Payments & coins', 'Verified badge', 'Rides', 'Messaging', 'Report abuse', 'Bug report', 'Other'];
const STATUS = { open: 'We’re on it', pending: 'Agent replied', resolved: 'Resolved' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (ts) => {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/* ---------- unread watcher (for a badge on the Settings row) ---------- */
export function watchSupportUnread({ auth, db, onChange }) {
  const user = auth.currentUser; if (!user) return () => {};
  const per = {}, subs = {};
  const emit = () => onChange(Object.values(per).reduce((a, n) => a + (n > 0 ? 1 : 0), 0));
  const stopIdx = onValue(ref(db, 'support_user_tickets/' + user.uid), (snap) => {
    const ids = Object.keys(snap.val() || {});
    ids.forEach(id => {
      if (subs[id]) return;
      subs[id] = onValue(ref(db, 'support_tickets/' + id + '/unreadForUser'), s => { per[id] = s.val() || 0; emit(); });
    });
  });
  return () => { stopIdx(); Object.values(subs).forEach(u => u()); };
}

/* ---------- styles (injected once) ---------- */
function injectStyles() {
  if (document.getElementById('hs-style')) return;
  const s = document.createElement('style'); s.id = 'hs-style';
  s.textContent = `
  .hs{--hs-bg:#FAF9F5;--hs-panel:#fff;--hs-soft:#F1EEE6;--hs-line:#E7E4DA;--hs-ink:#1F1E1D;--hs-mute:#6F6B63;--hs-brand:#111;--hs-brand-ink:#fff;--hs-dot:#D97757;--hs-bad:#B91C1C;
    position:fixed;inset:0;z-index:100020;background:var(--hs-bg);color:var(--hs-ink);display:flex;flex-direction:column;
    font:15px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;padding-top:env(safe-area-inset-top,0);padding-bottom:env(safe-area-inset-bottom,0)}
  @media (prefers-color-scheme:dark){.hs{--hs-bg:#191816;--hs-panel:#22211E;--hs-soft:#2E2D29;--hs-line:#34322D;--hs-ink:#F2F0EA;--hs-mute:#A7A298;--hs-brand:#F2F0EA;--hs-brand-ink:#191816}}
  .hs *{box-sizing:border-box}
  .hs-bar{display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--hs-panel);border-bottom:1px solid var(--hs-line)}
  .hs-bar h2{flex:1;margin:0;font:600 17px/1.2 Georgia,'Iowan Old Style',serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hs-bar small{display:block;font:12px system-ui;color:var(--hs-mute);font-weight:400}
  .hs button{font:inherit;color:inherit;cursor:pointer}
  .hs-ib{width:36px;height:36px;border:0;border-radius:10px;background:transparent;font-size:20px;line-height:1}
  .hs-ib:hover{background:var(--hs-soft)}
  .hs-body{flex:1;overflow:auto;width:100%;max-width:720px;margin:0 auto;padding:16px}
  .hs-btn{border:1px solid var(--hs-line);background:var(--hs-panel);border-radius:12px;padding:11px 16px;font-weight:600}
  .hs-btn.p{background:var(--hs-brand);color:var(--hs-brand-ink);border-color:var(--hs-brand)}
  .hs-btn:disabled{opacity:.5}
  .hs-tk{display:flex;gap:12px;align-items:center;width:100%;text-align:left;background:var(--hs-panel);border:1px solid var(--hs-line);border-radius:14px;padding:13px 14px;margin-bottom:10px}
  .hs-tk .g{flex:1;min-width:0}.hs-tk b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hs-tk span.m{display:block;color:var(--hs-mute);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hs-tk .t{color:var(--hs-mute);font-size:12px;text-align:right;white-space:nowrap}
  .hs-dot{display:inline-block;min-width:18px;height:18px;border-radius:9px;background:var(--hs-dot);color:#fff;font-size:11px;font-weight:700;text-align:center;line-height:18px;padding:0 5px;margin-top:4px}
  .hs-empty{text-align:center;color:var(--hs-mute);padding:48px 16px}
  .hs-empty h3{margin:0 0 6px;color:var(--hs-ink);font:600 20px Georgia,serif}
  .hs label{display:block;font-size:12.5px;font-weight:600;color:var(--hs-mute);margin:14px 0 6px}
  .hs input,.hs select,.hs textarea{width:100%;padding:11px 12px;border:1px solid var(--hs-line);border-radius:12px;background:var(--hs-panel);color:var(--hs-ink);font:inherit;outline:none}
  .hs input:focus,.hs select:focus,.hs textarea:focus{border-color:var(--hs-ink)}
  .hs textarea{min-height:120px;resize:vertical}
  .hs-msgs{display:flex;flex-direction:column;gap:8px}
  .hs-m{max-width:80%;display:flex;flex-direction:column;gap:2px}
  .hs-m .b{padding:9px 13px;border-radius:16px;white-space:pre-wrap;word-break:break-word}
  .hs-m.me{align-self:flex-end;align-items:flex-end}.hs-m.me .b{background:var(--hs-brand);color:var(--hs-brand-ink);border-bottom-right-radius:5px}
  .hs-m.ag{align-self:flex-start}.hs-m.ag .b{background:var(--hs-soft);border-bottom-left-radius:5px}
  .hs-m i{font-style:normal;font-size:11.5px;color:var(--hs-mute);padding:0 6px}
  .hs-sys{align-self:center;font-size:12.5px;color:var(--hs-mute);background:var(--hs-soft);border-radius:999px;padding:2px 12px}
  .hs-comp{display:flex;gap:10px;align-items:flex-end;padding:10px 14px;background:var(--hs-panel);border-top:1px solid var(--hs-line)}
  .hs-comp textarea{min-height:44px;max-height:140px;resize:none}
  .hs-rate{text-align:center;padding:14px;margin-top:14px;background:var(--hs-panel);border:1px solid var(--hs-line);border-radius:14px}
  .hs-rate button{border:0;background:none;font-size:28px;color:#C9A227;padding:2px 4px}
  .hs-err{color:var(--hs-bad);font-size:13px;margin-top:10px;min-height:18px}`;
  document.head.appendChild(s);
}

/* ---------- main entry ---------- */
export function openSupportChat({ auth, db, profile = {}, onClose } = {}) {
  injectStyles();
  const user = auth.currentUser;
  if (!user) throw new Error('openSupportChat: user must be signed in');
  const me = {
    uid: user.uid,
    name: profile.name || user.displayName || 'Haba user',
    photo: profile.photoURL || user.photoURL || '',
    phone: profile.phoneNumber || user.phoneNumber || ''
  };

  const root = document.createElement('div'); root.className = 'hs';
  document.body.appendChild(root);

  const tickets = {};            // tid -> ticket
  const tSubs = {};              // tid -> unsub
  let stopIndex = null, stopMsgs = null, openId = null, msgs = [];

  const cleanup = () => {
    if (stopIndex) stopIndex(); if (stopMsgs) stopMsgs();
    Object.values(tSubs).forEach(u => u());
    root.remove(); if (onClose) onClose();
  };

  /* ----- list view ----- */
  function showList() {
    if (stopMsgs) { stopMsgs(); stopMsgs = null; } openId = null;
    root.innerHTML = `
      <div class="hs-bar"><button class="hs-ib" data-a="close" aria-label="Close">‹</button><h2>Help &amp; Support<small>Chat with a live Haba agent</small></h2></div>
      <div class="hs-body" id="hs-list"></div>
      <div class="hs-comp" style="justify-content:center"><button class="hs-btn p" data-a="new" style="width:100%;max-width:688px">Start a new conversation</button></div>`;
    drawList();
  }
  function drawList() {
    const box = root.querySelector('#hs-list'); if (!box) return;
    const list = Object.values(tickets).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    box.innerHTML = list.length ? list.map(t => `
      <button class="hs-tk" data-open="${t.id}">
        <div class="g"><b>${esc(t.subject || 'Conversation')}</b><span class="m">${t.lastSender === 'user' ? 'You: ' : ''}${esc(t.lastMessage || '')}</span><span class="m">${esc(STATUS[t.status] || t.status)}</span></div>
        <div class="t">${when(t.updatedAt)}${t.unreadForUser > 0 ? `<br><span class="hs-dot">${t.unreadForUser}</span>` : ''}</div>
      </button>`).join('')
      : `<div class="hs-empty"><h3>Need a hand?</h3>Start a conversation and a Haba agent will reply here.</div>`;
  }

  /* ----- new ticket view ----- */
  function showNew() {
    root.innerHTML = `
      <div class="hs-bar"><button class="hs-ib" data-a="list" aria-label="Back">‹</button><h2>New conversation</h2></div>
      <div class="hs-body">
        <label for="hs-cat">What’s this about?</label>
        <select id="hs-cat">${CATEGORIES.map(c => `<option>${esc(c)}</option>`).join('')}</select>
        <label for="hs-sub">Subject</label>
        <input id="hs-sub" maxlength="100" placeholder="e.g. My badge payment didn’t go through">
        <label for="hs-msg">Tell us what happened</label>
        <textarea id="hs-msg" maxlength="2000" placeholder="Include any details that help us find your account or payment."></textarea>
        <div class="hs-err" id="hs-err"></div>
        <button class="hs-btn p" data-a="create" style="width:100%;margin-top:6px">Send to an agent</button>
      </div>`;
  }
  async function createTicket(btn) {
    const subject = root.querySelector('#hs-sub').value.trim();
    const text = root.querySelector('#hs-msg').value.trim();
    const err = root.querySelector('#hs-err');
    if (!subject) { err.textContent = 'Add a short subject.'; return; }
    if (!text) { err.textContent = 'Describe what you need help with.'; return; }
    btn.disabled = true; err.textContent = '';
    const tid = push(ref(db, 'support_tickets')).key;
    try {
      // 1) ticket + index (same shape the dashboard reads)
      await update(ref(db), {
        [`support_tickets/${tid}`]: {
          uid: me.uid, userName: me.name, userPhoto: me.photo, userPhone: me.phone,
          subject, category: root.querySelector('#hs-cat').value, priority: 'normal', status: 'open', source: 'user',
          createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
          lastMessage: text.slice(0, 140), lastSender: 'user', unreadForAgent: 1, unreadForUser: 0
        },
        [`support_user_tickets/${me.uid}/${tid}`]: true
      });
      // 2) first message (needs the ticket to exist for the security rules)
      await update(ref(db, `support_messages/${tid}`), {
        [push(ref(db, `support_messages/${tid}`)).key]: { text, sender: 'user', senderUid: me.uid, createdAt: serverTimestamp() }
      });
      showChat(tid);
    } catch (e) { console.error(e); err.textContent = 'Couldn’t send. Check your connection and try again.'; btn.disabled = false; }
  }

  /* ----- chat view ----- */
  function showChat(tid) {
    openId = tid;
    root.innerHTML = `
      <div class="hs-bar"><button class="hs-ib" data-a="list" aria-label="Back">‹</button><h2 id="hs-title"></h2></div>
      <div class="hs-body" id="hs-chat"><div class="hs-msgs" id="hs-msgs"></div><div id="hs-rate"></div></div>
      <div class="hs-comp"><textarea id="hs-in" rows="1" placeholder="Write a message…"></textarea><button class="hs-btn p" data-a="send">Send</button></div>`;
    const ta = root.querySelector('#hs-in');
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer:coarse)').matches) { e.preventDefault(); send(); } });
    if (stopMsgs) stopMsgs();
    stopMsgs = onValue(ref(db, 'support_messages/' + tid), (snap) => {
      msgs = []; snap.forEach(c => msgs.push({ id: c.key, ...c.val() }));
      drawChat(); markRead();
    });
    drawChat();
  }
  function drawChat() {
    const t = tickets[openId]; if (!t) return;
    const title = root.querySelector('#hs-title');
    if (title) title.innerHTML = `${esc(t.subject || 'Conversation')}<small>${esc(STATUS[t.status] || '')}</small>`;
    const box = root.querySelector('#hs-msgs'), wrap = root.querySelector('#hs-chat'); if (!box) return;
    const near = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 160;
    box.innerHTML = msgs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map(m => {
      if (m.sender === 'system') return `<div class="hs-sys">${esc(m.text)}</div>`;
      const mine = m.sender === 'user';
      return `<div class="hs-m ${mine ? 'me' : 'ag'}"><div class="b">${esc(m.text)}</div><i>${mine ? '' : esc(m.senderName || 'Haba Support') + ' · '}${when(m.createdAt)}</i></div>`;
    }).join('');
    const rate = root.querySelector('#hs-rate');
    if (t.status === 'resolved') {
      const r = typeof t.rating === 'number' ? t.rating : 0;
      rate.innerHTML = `<div class="hs-rate">${r ? 'Thanks for rating us.' : 'How did we do?'}<br>${[1, 2, 3, 4, 5].map(n => `<button data-rate="${n}" aria-label="${n} stars">${n <= r ? '★' : '☆'}</button>`).join('')}<div style="color:var(--hs-mute);font-size:13px">Reply below to reopen this conversation.</div></div>`;
    } else rate.innerHTML = '';
    if (near || !box.dataset.init) { wrap.scrollTop = wrap.scrollHeight; box.dataset.init = '1'; }
  }
  function markRead() {
    const t = tickets[openId];
    if (t && t.unreadForUser > 0) update(ref(db, `support_tickets/${openId}`), { unreadForUser: 0 }).catch(() => {});
  }
  async function send() {
    const ta = root.querySelector('#hs-in'); if (!ta || !openId) return;
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
        [`support_tickets/${tid}/status`]: 'open',      // reopens resolved tickets & puts it back in the agents' queue
        [`support_tickets/${tid}/resolvedAt`]: null
      });
    } catch (e) { console.error(e); ta.value = text; alert('Message not sent. Check your connection and try again.'); }
  }

  /* ----- events ----- */
  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]'), o = e.target.closest('[data-open]'), r = e.target.closest('[data-rate]');
    if (o) { showChat(o.dataset.open); return; }
    if (r && openId) { update(ref(db, `support_tickets/${openId}`), { rating: +r.dataset.rate }).catch(() => {}); return; }
    if (!a) return;
    ({ close: cleanup, list: showList, new: showNew, send, create: () => createTicket(a) })[a.dataset.a]?.();
  });
  document.addEventListener('keydown', function esc_(ev) {
    if (!document.body.contains(root)) { document.removeEventListener('keydown', esc_); return; }
    if (ev.key === 'Escape') cleanup();
  });

  /* ----- live data: my tickets ----- */
  stopIndex = onValue(ref(db, 'support_user_tickets/' + me.uid), (snap) => {
    Object.keys(snap.val() || {}).forEach(id => {
      if (tSubs[id]) return;
      tSubs[id] = onValue(ref(db, 'support_tickets/' + id), (s) => {
        if (s.exists()) tickets[id] = { id, ...s.val() }; else delete tickets[id];
        if (openId === id) { drawChat(); markRead(); } else if (!openId) drawList();
      });
    });
  });

  showList();
  return cleanup;
}
