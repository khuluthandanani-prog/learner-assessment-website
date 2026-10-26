
const API = '/api';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const esc = s =>
  String(s ?? '').replace(/[&<>"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[c]));

const fmt = d =>
  d ? new Date(d).toLocaleString('en-ZA', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }) : '—';

// RISE COLLECTIVE brand symbol
const LOGO = '<svg viewBox="0 0 64 64" role="img" aria-label="RISE COLLECTIVE logo"><circle cx="32" cy="32" r="31.5" fill="#fff"/><circle cx="32" cy="32" r="26" fill="#fff" stroke="#0f1b3d" stroke-width="3"/><path d="M32 6A26 26 0 0 1 56.4 40.9" fill="none" stroke="#c9a227" stroke-width="3.6" stroke-linecap="round"/><path d="M32 8V15M16.6 13.6L21.1 19M47.4 13.6L42.9 19" stroke="#c9a227" stroke-width="2.4" stroke-linecap="round" fill="none"/><circle cx="32" cy="27" r="4.2" fill="#0f1b3d"/><path d="M32 31.2V43.8M26.2 40.9L32 37.1L37.8 40.9M27.3 48.7L32 43.8L36.7 48.7" stroke="#0f1b3d" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';

$$('.logo').forEach(e => {
  e.innerHTML = LOGO;
});

const session = () => {
  try {
    return JSON.parse(localStorage.getItem('rise_session'));
  } catch (e) {
    return null;
  }
};

const saveSession = x =>
  localStorage.setItem('rise_session', JSON.stringify(x));

const logout = () => {
  localStorage.removeItem('rise_session');
  location.href = 'index.html';
};

async function api(path, opts = {}) {
  const me = session();

  const r = await fetch(API + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-id': (me && me.id) || '',
      ...(opts.headers || {})
    }
  });

  const d = await r.json().catch(() => ({}));

  if (!r.ok) {
    throw Error(d.error || 'Server error');
  }

  return d;
}

function guard(role) {
  const u = session();

  const staff = r =>
    r === 'admin' || r === 'lecturer' || r === 'tutor';

  const ok = u && (
    staff(role) ? staff(u.role) : u.role === role
  );

  if (!ok) {
    logout();
    return null;
  }

  const w = $('#who');
  if (w) w.textContent = u.name;

  return u;
}

const readFile = f => new Promise((res, rej) => {
  if (!f) return res(null);

  if (f.size > 1.5e6) {
    return rej('File too large (max 1.5MB).');
  }

  const r = new FileReader();

  r.onload = () => res({
    name: f.name,
    data: r.result
  });

  r.onerror = () => rej('Could not read file.');

  r.readAsDataURL(f);
});

const fileLink = f =>
  f
    ? `<a class="btn sm" href="${f.data}" download="${esc(f.name)}">⬇ ${esc(f.name)}</a>`
    : '';

// Hide learner-management controls from junior tutors.
function hideTutorTabs() {
  const u = session();

  if (!u || u.role !== 'tutor') return;

  $$('button').forEach(b => {
    const t = b.textContent.trim();

    if (t.length < 25 && /learners/i.test(t)) {
      b.style.display = 'none';
    }
  });

  $$('.tile[data-t="lp"]').forEach(t => {
    t.style.display = 'none';
  });
}

// Create a dashboard tile without duplicating existing tiles.
function addTile(id, href, ico, title, desc) {
  const box = $('.tiles');

  if (!box || $('#' + id)) return null;

  const a = document.createElement('a');

  a.id = id;
  a.className = 'tile';
  a.href = href;

  a.innerHTML = `
    <span class="ico">${ico}</span>
    <div>
      <div class="count" hidden></div>
      <h3>${title}</h3>
      <p>${desc}</p>
    </div>
  `;

  box.appendChild(a);

  return a;
}

// Add links according to the existing logged-in role and page.
function addLinks() {
  const u = session();

  if (!u) return;

  const onLec = /lecturer\.html$/.test(location.pathname);
  const onAny = /(lecturer|learner)\.html$/.test(location.pathname);

  // Admin and lecturer: registered junior tutors.
  if (
    onLec &&
    (u.role === 'admin' || u.role === 'lecturer')
  ) {
    addTile(
      'tutorsLink',
      'tutors.html',
      '👥',
      'Junior Tutors',
      'Registered junior tutors'
    );
  }

  // Admin only: video day-pass requests.
  if (onLec && u.role === 'admin') {
    addTile(
      'passLink',
      'passes.html',
      '💳',
      'Day Passes',
      'Video day-pass requests'
    );
  }

  // Admin only: sharing report.
  if (onLec && u.role === 'admin') {
    const a = addTile(
      'shareLink',
      'sharing.html',
      '🚩',
      'Sharing Report',
      'Accounts flagged for sharing'
    );

    if (a) {
      api('/admin/sharing')
        .then(d => {
          if (d.flagged > 0) {
            const c = $('.count', a);

            if (c) {
              c.textContent = d.flagged;
              c.hidden = false;
            }

            a.style.borderColor = '#c0392b';
          }
        })
        .catch(() => {
          // Keep the dashboard usable if the count cannot load.
        });
    }
  }

  // Learners: retain their existing assessments and study resources.
  // All logged-in roles on these pages can access Notes & Videos.
  if (onAny) {
    addTile(
      'resLink',
      'resources.html',
      '📚',
      'Notes & Videos',
      'Study material'
    );
  }

  hideTutorTabs();
}

document.addEventListener('DOMContentLoaded', addLinks);
window.addEventListener('load', addLinks);
