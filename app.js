
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
  d
    ? new Date(d).toLocaleString('en-ZA', {
        dateStyle: 'medium',
        timeStyle: 'short'
      })
    : '—';

const LOGO = '<svg viewBox="0 0 64 64"><rect x="24" y="2" width="16" height="14" rx="3" fill="#c9a227"/><rect x="24" y="48" width="16" height="14" rx="3" fill="#c9a227"/><circle cx="32" cy="32" r="18" fill="#0f1b3d" stroke="#c9a227" stroke-width="3"/><path d="M32 32V21M32 32l8 4" stroke="#fff" stroke-width="2.5" stroke-linecap="round" fill="none"/><circle cx="32" cy="32" r="2" fill="#c9a227"/></svg>';

$$('.logo').forEach(e => {
  e.innerHTML = LOGO;
});

// Retrieve the current browser session.
const session = () => {
  try {
    return JSON.parse(localStorage.getItem('rise_session'));
  } catch (e) {
    return null;
  }
};

// Save the authenticated user session.
const saveSession = x => {
  localStorage.setItem('rise_session', JSON.stringify(x));
};

// Log out locally and return to the login page.
const logout = () => {
  localStorage.removeItem('rise_session');
  location.href = 'index.html';
};

// API helper — includes the signed-in user's ID in requests.
async function api(path, opts = {}) {
  const me = session();

  const headers = {
    ...(opts.headers || {}),
    'Content-Type': 'application/json'
  };

  // The backend checks this header for admin/lecturer permissions.
  if (me && me.id) {
    headers['x-admin-id'] = me.id;
  }

  const r = await fetch(API + path, {
    ...opts,
    headers
  });

  const d = await r.json().catch(() => ({}));

  if (!r.ok) {
    throw new Error(d.error || 'Server error');
  }

  return d;
}

// Check whether the current session has the required role.
function guard(role) {
  const u = session();

  const staff = r => r === 'admin' || r === 'lecturer';

  const ok = u && (
    staff(role)
      ? staff(u.role)
      : u.role === role
  );

  if (!ok) {
    logout();
    return null;
  }

  const w = $('#who');

  if (w) {
    w.textContent = u.name;
  }

  return u;
}

// Read a file and convert it to a data URL.
const readFile = f => new Promise((res, rej) => {
  if (!f) {
    return res(null);
  }

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

// Generate a download link for an uploaded file.
const fileLink = f =>
  f
    ? `<a class="btn sm" href="${f.data}" download="${esc(f.name)}">⬇ ${esc(f.name)}</a>`
    : '';
