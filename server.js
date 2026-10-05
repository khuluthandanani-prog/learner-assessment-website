const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json({ limit: '3mb' }));
app.use(express.static(__dirname));

const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function init() {
  if (!process.env.DATABASE_URL) throw Error('DATABASE_URL is not configured');

  // FRESH START: set RESET_DATABASE=true on Render for ONE deploy to wipe everything.
  // Remove the variable afterwards, otherwise data is wiped on every restart.
  if (process.env.RESET_DATABASE === 'true') {
    console.log('RESET_DATABASE=true -> wiping all data');
    await pool.query('DROP TABLE IF EXISTS rise_submissions, rise_assessments, rise_users CASCADE');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rise_users(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'learner',
      status TEXT NOT NULL DEFAULT 'pending',
      last_login TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS rise_assessments(
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      total INTEGER NOT NULL,
      due TIMESTAMPTZ NOT NULL,
      file_name TEXT,
      file_data TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS rise_submissions(
      id TEXT PRIMARY KEY,
      assessment_id TEXT NOT NULL REFERENCES rise_assessments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES rise_users(id) ON DELETE CASCADE,
      text TEXT DEFAULT '',
      file_name TEXT,
      file_data TEXT,
      submitted_at TIMESTAMPTZ DEFAULT NOW(),
      mark INTEGER,
      feedback TEXT DEFAULT '',
      marked_at TIMESTAMPTZ,
      UNIQUE(assessment_id, user_id)
    );
  `);

  // Seed the first admin/lecturer account from environment variables
  const email = (process.env.ADMIN_EMAIL || 'admin@rise.com').toLowerCase();
  const pass = process.env.ADMIN_PASSWORD || 'change-this-admin-password';
  const role = process.env.ADMIN_ROLE === 'lecturer' ? 'lecturer' : 'admin';

  const exists = await pool.query('SELECT 1 FROM rise_users WHERE email=$1', [email]);
  if (!exists.rowCount) {
    await pool.query(
      'INSERT INTO rise_users(id,name,email,password_hash,role,status) VALUES($1,$2,$3,$4,$5,$6)',
      [id(), 'RISE COLLECTIVE Admin', email, await bcrypt.hash(pass, 12), role, 'approved']
    );
  }
}

// Allows approved admins and lecturers
async function admin(req, res, next) {
  try {
    const x = await pool.query(
      "SELECT id FROM rise_users WHERE id=$1 AND role IN ('admin','lecturer') AND status='approved'",
      [req.headers['x-admin-id']]
    );
    if (!x.rowCount) return res.status(403).json({ error: 'Admin access denied' });
    next();
  } catch (e) {
    next(e);
  }
}

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Register. Learners are created as 'pending'.
// Lecturers must send role:'lecturer' and a code matching the LECTURER_CODE env variable.
app.post('/api/auth/register', async (req, res) => {
  try {
    let { name, email, password, role, code } = req.body;
    if (!name || !email || !password || password.length < 6)
      return res.status(400).json({ error: 'Name, email and password (6+ characters) are required.' });

    email = email.trim().toLowerCase();
    if ((await pool.query('SELECT 1 FROM rise_users WHERE email=$1', [email])).rowCount)
      return res.status(409).json({ error: 'Email already registered.' });

    let newRole = 'learner';
    let status = 'pending';

    if (role === 'lecturer') {
      if (!process.env.LECTURER_CODE || code !== process.env.LECTURER_CODE)
        return res.status(403).json({ error: 'Invalid lecturer registration code.' });
      newRole = 'lecturer';
      status = 'approved';
    }

    await pool.query(
      'INSERT INTO rise_users(id,name,email,password_hash,role,status) VALUES($1,$2,$3,$4,$5,$6)',
      [id(), name.trim(), email, await bcrypt.hash(password, 12), newRole, status]
    );
    res.json({ ok: true, role: newRole, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Login. On failure the response has { error } and NO user,
// so the browser code must check for data.error before reading data.user.role
app.post('/api/auth/login', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM rise_users WHERE email=$1', [
      String(req.body.email || '').trim().toLowerCase()
    ]);
    if (!r.rowCount) return res.status(401).json({ error: 'Wrong email or password.' });

    const u = r.rows[0];
    if (!(await bcrypt.compare(req.body.password || '', u.password_hash)))
      return res.status(401).json({ error: 'Wrong email or password.' });
    if (u.status === 'pending')
      return res.status(403).json({ error: 'Your registration is awaiting Lecturer/Admin approval.' });
    if (u.status === 'blocked')
      return res.status(403).json({ error: 'Your account has been blocked.' });

    await pool.query('UPDATE rise_users SET last_login=NOW() WHERE id=$1', [u.id]);
    res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const withFile = x => ({ ...x, file: x.file_name ? { name: x.file_name, data: x.file_data } : null });

app.get('/api/admin/data', admin, async (req, res) => {
  try {
    const [a, s, l] = await Promise.all([
      pool.query('SELECT id,title,description AS desc,total,due,file_name,file_data FROM rise_assessments ORDER BY created_at DESC'),
      pool.query('SELECT id,assessment_id AS aid,user_id AS uid,text,file_name,file_data,submitted_at AS at,mark,feedback FROM rise_submissions ORDER BY submitted_at DESC'),
      pool.query("SELECT id,name,email,status,last_login AS \"lastLogin\" FROM rise_users WHERE role='learner' ORDER BY name")
    ]);
    res.json({ assessments: a.rows.map(withFile), submissions: s.rows.map(withFile), learners: l.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/learner/data', async (req, res) => {
  try {
    const uid = req.query.userId;
    const u = await pool.query("SELECT status FROM rise_users WHERE id=$1 AND role='learner'", [uid]);
    if (!u.rowCount || u.rows[0].status !== 'approved')
      return res.status(403).json({ error: 'Account not approved' });

    const [a, s] = await Promise.all([
      pool.query('SELECT id,title,description AS desc,total,due,file_name,file_data FROM rise_assessments ORDER BY created_at DESC'),
      pool.query('SELECT id,assessment_id AS aid,text,file_name,file_data,submitted_at AS at,mark,feedback FROM rise_submissions WHERE user_id=$1', [uid])
    ]);
    res.json({ assessments: a.rows.map(withFile), submissions: s.rows.map(withFile) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/assessments', admin, async (req, res) => {
  try {
    const { title, desc, total, due, file } = req.body;
    const x = id();
    await pool.query(
      'INSERT INTO rise_assessments(id,title,description,total,due,file_name,file_data) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [x, title, desc || '', +total, due, file?.name || null, file?.data || null]
    );
    res.json({ ok: true, id: x });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/assessments/:id', admin, async (req, res) => {
  try {
    await pool.query('DELETE FROM rise_assessments WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/submissions', async (req, res) => {
  try {
    const { uid, aid, text, file } = req.body;
    const u = await pool.query("SELECT status FROM rise_users WHERE id=$1 AND role='learner'", [uid]);
    if (!u.rowCount || u.rows[0].status !== 'approved')
      return res.status(403).json({ error: 'Account not approved' });

    await pool.query(
      `INSERT INTO rise_submissions(id,assessment_id,user_id,text,file_name,file_data,submitted_at)
       VALUES($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT(assessment_id,user_id) DO UPDATE
       SET text=EXCLUDED.text,file_name=EXCLUDED.file_name,file_data=EXCLUDED.file_data,
           submitted_at=NOW(),mark=NULL,feedback=''`,
      [id(), aid, uid, text || '', file?.name || null, file?.data || null]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/submissions/:id', admin, async (req, res) => {
  try {
    await pool.query(
      'UPDATE rise_submissions SET mark=$1,feedback=$2,marked_at=NOW() WHERE id=$3',
      [+req.body.mark, req.body.feedback || '', req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/users/:id', admin, async (req, res) => {
  try {
    if (!['pending', 'approved', 'blocked'].includes(req.body.status))
      return res.status(400).json({ error: 'Invalid status' });
    await pool.query("UPDATE rise_users SET status=$1 WHERE id=$2 AND role='learner'", [req.body.status, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/users/:id/password', admin, async (req, res) => {
  try {
    if (!req.body.password || req.body.password.length < 6)
      return res.status(400).json({ error: 'Password must be 6+ characters' });
    await pool.query(
      "UPDATE rise_users SET password_hash=$1 WHERE id=$2 AND role='learner'",
      [await bcrypt.hash(req.body.password, 12), req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/users/:id', admin, async (req, res) => {
  try {
    await pool.query("DELETE FROM rise_users WHERE id=$1 AND role='learner'", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

init()
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log('RISE COLLECTIVE running on ' + PORT)))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
