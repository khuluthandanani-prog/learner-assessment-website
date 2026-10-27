const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; this makes req.ip the visitor's real IP
const PORT = process.env.PORT || 10000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use(express.static(__dirname));

const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Day pass settings (change them in Render > Environment, no code change needed)
const PASS_PRICE = Number(process.env.PASS_PRICE) > 0 ? Number(process.env.PASS_PRICE) : 10;   // rand
const PASS_HOURS = parseInt(process.env.PASS_HOURS, 10) > 0 ? parseInt(process.env.PASS_HOURS, 10) : 24;
const PAYENV = process.env;
const PAY_INSTRUCTIONS = PAYENV.PAY_INSTRUCTIONS || [
  PAYENV['POS-NAME'] && 'Account name: ' + PAYENV['POS-NAME'],
  PAYENV['BANK'] && 'Bank: ' + PAYENV['BANK'],
  PAYENV['ACC-NUMBR'] && 'Account number: ' + PAYENV['ACC-NUMBR'],
  PAYENV['BRANCH-CODE'] && 'Branch code: ' + PAYENV['BRANCH-CODE'],
  PAYENV['REF-TO-USE'] && 'Reference: ' + PAYENV['REF-TO-USE']
].filter(Boolean).join('\n') || 'Ask your lecturer for the payment details.';
// Sharing report: a learner is flagged when, within one pass period, their videos were opened from
// this many different internet addresses or different devices/browsers (or more)
const SHARE_MAX_IPS = parseInt(process.env.SHARE_MAX_IPS, 10) > 0 ? parseInt(process.env.SHARE_MAX_IPS, 10) : 3;
const SHARE_MAX_DEVICES = parseInt(process.env.SHARE_MAX_DEVICES, 10) > 0 ? parseInt(process.env.SHARE_MAX_DEVICES, 10) : 3;

// ---- One-time secret admin registration ----
// Set ADMIN_SETUP_CODE in Render. The first person to register with it becomes an admin,
// after which the option disappears from the form and the server refuses it for good.
function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const adminTries = new Map(); // internet address -> failed attempts in the last hour
const tooManyTries = ip => { const r = adminTries.get(ip); return !!r && Date.now() - r.t < 3600000 && r.n >= 10; };
const noteFail = ip => {
  const r = adminTries.get(ip);
  if (!r || Date.now() - r.t >= 3600000) adminTries.set(ip, { n: 1, t: Date.now() }); else r.n++;
};
async function secretAdminAvailable() {
  if (!process.env.ADMIN_SETUP_CODE) return false;
  const u = await pool.query("SELECT 1 FROM rise_settings WHERE key='secret_admin_used'");
  return !u.rowCount;
}

async function init() {
  if (!process.env.DATABASE_URL) throw Error('DATABASE_URL is not configured');

  // FRESH START: set RESET_DATABASE=true on Render for ONE deploy to wipe everything.
  // Remove the variable afterwards, otherwise data is wiped on every restart.
  if (process.env.RESET_DATABASE === 'true') {
    console.log('RESET_DATABASE=true -> wiping all data');
    await pool.query('DROP TABLE IF EXISTS rise_applications, rise_comp_subs, rise_comp_papers, rise_comp_regs, rise_settings, rise_video_log, rise_passes, rise_resources, rise_submissions, rise_assessments, rise_users CASCADE');
    await pool.query('DROP SEQUENCE IF EXISTS rise_student_seq');
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
    CREATE TABLE IF NOT EXISTS rise_resources(
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      type TEXT NOT NULL,
      url TEXT,
      file_name TEXT,
      file_data TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS rise_passes(
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES rise_users(id) ON DELETE CASCADE,
      reference TEXT NOT NULL,
      amount NUMERIC(8,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TIMESTAMPTZ DEFAULT NOW(),
      activated_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS rise_video_log(
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES rise_users(id) ON DELETE CASCADE,
      resource_id TEXT,
      ip TEXT,
      ua TEXT,
      at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS rise_video_log_user_at ON rise_video_log(user_id, at);
    CREATE TABLE IF NOT EXISTS rise_settings(
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Records who created each assessment (used to limit junior tutors to their own work)
  await pool.query('ALTER TABLE rise_assessments ADD COLUMN IF NOT EXISTS created_by TEXT');

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

// Approved admins and lecturers (learner and junior tutor management)
async function admin(req, res, next) {
  try {
    const x = await pool.query(
      "SELECT id,role FROM rise_users WHERE id=$1 AND role IN ('admin','lecturer') AND status='approved'",
      [req.headers['x-admin-id']]
    );
    if (!x.rowCount) return res.status(403).json({ error: 'Admin access denied' });
    req.user = x.rows[0];
    next();
  } catch (e) {
    next(e);
  }
}

// ADMIN ONLY (not lecturers, not tutors): day passes, payments and the sharing report
async function adminOnly(req, res, next) {
  try {
    const x = await pool.query(
      "SELECT id,role FROM rise_users WHERE id=$1 AND role='admin' AND status='approved'",
      [req.headers['x-admin-id']]
    );
    if (!x.rowCount) return res.status(403).json({ error: 'Admin access denied' });
    req.user = x.rows[0];
    next();
  } catch (e) {
    next(e);
  }
}

// Approved admins, lecturers AND approved junior tutors (assessments, marking, posting notes)
async function staff(req, res, next) {
  try {
    const x = await pool.query(
      "SELECT id,role FROM rise_users WHERE id=$1 AND role IN ('admin','lecturer','tutor') AND status='approved'",
      [req.headers['x-admin-id']]
    );
    if (!x.rowCount) return res.status(403).json({ error: 'Access denied' });
    req.user = x.rows[0];
    next();
  } catch (e) {
    next(e);
  }
}

// Any approved user: learners, tutors, lecturers, admins
async function anyUser(req, res, next) {
  try {
    const x = await pool.query(
      "SELECT id,role FROM rise_users WHERE id=$1 AND status='approved'",
      [req.headers['x-admin-id']]
    );
    if (!x.rowCount) return res.status(403).json({ error: 'Please log in again.' });
    req.user = x.rows[0];
    next();
  } catch (e) {
    next(e);
  }
}

const isStaffRole = r => ['admin', 'lecturer', 'tutor'].includes(r);

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Register.
// Learners: need the student number from an ACCEPTED application, then the account is approved at once.
// Lecturers: role:'lecturer' + code matching LECTURER_CODE, approved immediately.
// Junior tutors: the email of an ACCEPTED tutor application (approved at once),
//   or the old role:'tutor' + TUTOR_CODE route (pending until an admin/lecturer approves).
// Secret admin: role:'secretadmin' + code matching ADMIN_SETUP_CODE, works for ONE registration only.
//   New email  -> creates a new admin account.
//   Existing email + that account's current password -> upgrades that account to admin.
app.post('/api/auth/register', async (req, res) => {
  try {
    let { name, email, password, role, code } = req.body;
    if (!name || !email || !password || password.length < 6)
      return res.status(400).json({ error: 'Name, email and password (6+ characters) are required.' });

    email = email.trim().toLowerCase();
    const ex = await pool.query('SELECT id,password_hash,role FROM rise_users WHERE email=$1', [email]);
    // An existing email is only allowed for the secret admin upgrade below
    if (ex.rowCount && role !== 'secretadmin')
      return res.status(409).json({ error: 'Email already registered.' });

    let newRole = 'learner';
    let status = 'pending';
    let secret = false;
    let upgradeId = null;
    let appId = null;
    let studentNo = null;

    if (role === 'lecturer') {
      if (!process.env.LECTURER_CODE || code !== process.env.LECTURER_CODE)
        return res.status(403).json({ error: 'Invalid lecturer registration code.' });
      newRole = 'lecturer';
      status = 'approved';
    } else if (role === 'tutor') {
      const ap = await pool.query(
        "SELECT id FROM rise_applications WHERE type='tutor' AND status='accepted' AND user_id IS NULL AND LOWER(email)=$1 ORDER BY created_at DESC LIMIT 1",
        [email]);
      if (ap.rowCount) {
        appId = ap.rows[0].id;
        status = 'approved';
      } else if (process.env.TUTOR_CODE && code === process.env.TUTOR_CODE) {
        status = 'pending';
      } else {
        return res.status(403).json({ error: 'Your tutor application has not been accepted yet. Apply first, using the same email.' });
      }
      newRole = 'tutor';
    } else if (role === 'secretadmin') {
      if (tooManyTries(req.ip))
        return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      if (!(await secretAdminAvailable()) || !safeEqual(code, process.env.ADMIN_SETUP_CODE)) {
        noteFail(req.ip);
        return res.status(403).json({ error: 'Invalid or expired admin code.' });
      }
      if (ex.rowCount) {
        // Upgrade an existing account: needs the secret code AND that account's current password
        if (!(await bcrypt.compare(password, ex.rows[0].password_hash))) {
          noteFail(req.ip);
          return res.status(403).json({ error: 'Invalid or expired admin code.' });
        }
        if (ex.rows[0].role === 'admin')
          return res.status(400).json({ error: 'That account is already an admin.' });
        upgradeId = ex.rows[0].id;
      }
      newRole = 'admin';
      status = 'approved';
      secret = true;
    } else {
      // Learner: must use the student number from an accepted application
      const sn = String(req.body.studentNumber || '').replace(/\D/g, '');
      const ap = sn.length === 10
        ? await pool.query("SELECT id FROM rise_applications WHERE type='learner' AND student_number=$1 AND status='accepted' AND user_id IS NULL", [sn])
        : { rowCount: 0 };
      if (!ap.rowCount)
        return res.status(403).json({ error: 'Student number not found, or your application has not been accepted yet.' });
      appId = ap.rows[0].id;
      studentNo = sn;
      status = 'approved';
    }

    const uid = upgradeId || id();
    if (secret) {
      // Claim the one-time option; only one registration can ever win this
      const claim = await pool.query(
        "INSERT INTO rise_settings(key,value) VALUES('secret_admin_used',$1) ON CONFLICT (key) DO NOTHING", [uid]);
      if (!claim.rowCount) return res.status(403).json({ error: 'Invalid or expired admin code.' });
    }
    if (appId) {
      // Claim the application so it can only be used for one account
      const c = await pool.query('UPDATE rise_applications SET user_id=$1 WHERE id=$2 AND user_id IS NULL', [uid, appId]);
      if (!c.rowCount) return res.status(409).json({ error: 'This application has already been used to register.' });
    }
    try {
      if (upgradeId) {
        await pool.query("UPDATE rise_users SET role='admin',status='approved' WHERE id=$1", [upgradeId]);
      } else {
        await pool.query(
          'INSERT INTO rise_users(id,name,email,password_hash,role,status,student_number) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [uid, name.trim(), email, await bcrypt.hash(password, 12), newRole, status, studentNo]
        );
      }
    } catch (err) {
      if (secret) await pool.query("DELETE FROM rise_settings WHERE key='secret_admin_used'");
      if (appId) await pool.query('UPDATE rise_applications SET user_id=NULL WHERE id=$1', [appId]);
      throw err;
    }
    res.json({ ok: true, role: newRole, status, upgraded: !!upgradeId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Tells the registration page whether the one-time secret admin option should be shown
app.get('/api/auth/options', async (req, res) => {
  try {
    res.json({ secretAdmin: await secretAdminAvailable() });
  } catch (e) {
    res.json({ secretAdmin: false });
  }
});

// Login. On failure the response has { error } and NO user.
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

// Admins/lecturers see everything. Tutors see only their own assessments,
// the submissions to them, and only the learners who submitted to them.
app.get('/api/admin/data', staff, async (req, res) => {
  try {
    const tutor = req.user.role === 'tutor';
    const p = tutor ? [req.user.id] : [];

    const aQ = pool.query(
      'SELECT id,title,description AS desc,total,due,file_name,file_data FROM rise_assessments' +
      (tutor ? ' WHERE created_by=$1' : '') + ' ORDER BY created_at DESC', p);

    const sQ = pool.query(
      'SELECT s.id,s.assessment_id AS aid,s.user_id AS uid,s.text,s.file_name,s.file_data,s.submitted_at AS at,s.mark,s.feedback FROM rise_submissions s' +
      (tutor ? ' JOIN rise_assessments a ON a.id=s.assessment_id WHERE a.created_by=$1' : '') +
      ' ORDER BY s.submitted_at DESC', p);

    const lQ = tutor
      ? pool.query(
          `SELECT DISTINCT u.id,u.name,u.email,u.status,u.last_login AS "lastLogin"
           FROM rise_users u
           JOIN rise_submissions s ON s.user_id=u.id
           JOIN rise_assessments a ON a.id=s.assessment_id
           WHERE u.role='learner' AND a.created_by=$1
           ORDER BY u.name`, p)
      : pool.query("SELECT id,name,email,status,last_login AS \"lastLogin\" FROM rise_users WHERE role='learner' ORDER BY name");

    const [a, s, l] = await Promise.all([aQ, sQ, lQ]);
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
    const now = new Date();
    res.json({
      assessments: a.rows.map(x => ({ ...withFile(x), closed: now > new Date(x.due) })),
      submissions: s.rows.map(withFile)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/assessments', staff, async (req, res) => {
  try {
    const { title, desc, total, due, file } = req.body;

    // Deadlines typed are South African time (UTC+2). Add the offset if none was sent.
    let dueStr = String(due || '').trim().replace(' ', 'T');
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(dueStr)) {
      if (/T\d{2}:\d{2}$/.test(dueStr)) dueStr += ':00';
      dueStr += '+02:00';
    }
    if (isNaN(new Date(dueStr)))
      return res.status(400).json({ error: 'Invalid deadline.' });

    const x = id();
    await pool.query(
      'INSERT INTO rise_assessments(id,title,description,total,due,file_name,file_data,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [x, title, desc || '', +total, dueStr, file?.name || null, file?.data || null, req.user.id]
    );
    res.json({ ok: true, id: x });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Tutors can delete only their own assessments
app.delete('/api/assessments/:id', staff, async (req, res) => {
  try {
    const r = req.user.role === 'tutor'
      ? await pool.query('DELETE FROM rise_assessments WHERE id=$1 AND created_by=$2', [req.params.id, req.user.id])
      : await pool.query('DELETE FROM rise_assessments WHERE id=$1', [req.params.id]);
    if (!r.rowCount) return res.status(403).json({ error: 'You can only delete your own assessments.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Submissions are refused automatically once the deadline has passed
app.post('/api/submissions', async (req, res) => {
  try {
    const { uid, aid, text, file } = req.body;
    const u = await pool.query("SELECT status FROM rise_users WHERE id=$1 AND role='learner'", [uid]);
    if (!u.rowCount || u.rows[0].status !== 'approved')
      return res.status(403).json({ error: 'Account not approved' });

    const a = await pool.query('SELECT due FROM rise_assessments WHERE id=$1', [aid]);
    if (!a.rowCount)
      return res.status(404).json({ error: 'Assessment not found.' });
    if (new Date() > new Date(a.rows[0].due))
      return res.status(403).json({ error: 'Submission closed. The deadline for this assessment has passed.' });

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

// Marking. Tutors can mark only submissions to their own assessments.
app.patch('/api/submissions/:id', staff, async (req, res) => {
  try {
    const r = req.user.role === 'tutor'
      ? await pool.query(
          `UPDATE rise_submissions SET mark=$1,feedback=$2,marked_at=NOW()
           WHERE id=$3 AND assessment_id IN (SELECT id FROM rise_assessments WHERE created_by=$4)`,
          [+req.body.mark, req.body.feedback || '', req.params.id, req.user.id])
      : await pool.query(
          'UPDATE rise_submissions SET mark=$1,feedback=$2,marked_at=NOW() WHERE id=$3',
          [+req.body.mark, req.body.feedback || '', req.params.id]);
    if (!r.rowCount) return res.status(403).json({ error: 'You can only mark submissions to your own assessments.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Learner management: admins and lecturers ONLY
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

// ---- Junior tutor management (admins and lecturers only) ----
app.get('/api/admin/tutors', admin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT u.id,u.name,u.email,u.status,u.last_login AS "lastLogin",
        (SELECT COUNT(*) FROM rise_assessments a WHERE a.created_by=u.id)::int AS assessments,
        (SELECT COUNT(*) FROM rise_submissions s JOIN rise_assessments a ON a.id=s.assessment_id
          WHERE a.created_by=u.id AND s.mark IS NOT NULL)::int AS marked
      FROM rise_users u WHERE u.role='tutor'
      ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, u.name`);
    res.json({ tutors: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/tutors/:id', admin, async (req, res) => {
  try {
    if (!['pending', 'approved', 'blocked'].includes(req.body.status))
      return res.status(400).json({ error: 'Invalid status' });
    await pool.query("UPDATE rise_users SET status=$1 WHERE id=$2 AND role='tutor'", [req.body.status, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/tutors/:id', admin, async (req, res) => {
  try {
    await pool.query("DELETE FROM rise_users WHERE id=$1 AND role='tutor'", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Notes and online videos ----
// List (no file contents, and NO video links for learners: links are only given out by /video below).
app.get('/api/resources', anyUser, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT r.id,r.subject,r.title,r.description AS "desc",r.type,r.file_name AS "fileName",
             r.created_by AS "createdBy",u.name AS "by",r.created_at AS at
      FROM rise_resources r LEFT JOIN rise_users u ON u.id=r.created_by
      ORDER BY r.created_at DESC`);
    res.json({ resources: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download one attached notes file (notes stay free)
app.get('/api/resources/:id/file', anyUser, async (req, res) => {
  try {
    const r = await pool.query('SELECT file_name,file_data FROM rise_resources WHERE id=$1', [req.params.id]);
    if (!r.rowCount || !r.rows[0].file_data) return res.status(404).json({ error: 'File not found.' });
    res.json({ name: r.rows[0].file_name, data: r.rows[0].file_data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Video link: staff always; learners ONLY while they have an active day pass
app.get('/api/resources/:id/video', anyUser, async (req, res) => {
  try {
    const r = await pool.query("SELECT url FROM rise_resources WHERE id=$1 AND type='video'", [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Video not found.' });

    if (!isStaffRole(req.user.role)) {
      const p = await pool.query(
        "SELECT 1 FROM rise_passes WHERE user_id=$1 AND status='active' AND expires_at>NOW()",
        [req.user.id]
      );
      if (!p.rowCount)
        return res.status(403).json({ error: 'Day pass required. Get a day pass to watch videos.' });

      // Record every time a learner opens a video (used by the sharing report)
      await pool.query(
        'INSERT INTO rise_video_log(id,user_id,resource_id,ip,ua) VALUES($1,$2,$3,$4,$5)',
        [id(), req.user.id, req.params.id, String(req.ip || '').slice(0, 64), String(req.headers['user-agent'] || '').slice(0, 200)]
      );
    }
    res.json({ url: r.rows[0].url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Post notes or a video link (admins, lecturers, approved junior tutors)
app.post('/api/resources', staff, async (req, res) => {
  try {
    const { subject, title, desc, type, url, file } = req.body;
    const sub = String(subject || '').trim().slice(0, 80);
    const ttl = String(title || '').trim().slice(0, 200);
    if (!sub || !ttl) return res.status(400).json({ error: 'Subject and title are required.' });
    if (!['note', 'video'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });

    let link = null;
    if (type === 'video') {
      try {
        const u = new URL(String(url || '').trim());
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad');
        link = u.href;
      } catch (e) {
        return res.status(400).json({ error: 'Enter a valid video link starting with http:// or https://' });
      }
    } else if (!file && !String(desc || '').trim()) {
      return res.status(400).json({ error: 'Add a file or some notes text.' });
    }

    const x = id();
    await pool.query(
      'INSERT INTO rise_resources(id,subject,title,description,type,url,file_name,file_data,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [x, sub, ttl, String(desc || '').slice(0, 20000), type, link,
       type === 'note' ? (file?.name || null) : null, type === 'note' ? (file?.data || null) : null, req.user.id]
    );
    res.json({ ok: true, id: x });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Tutors can delete only their own posts; admins and lecturers can delete any
app.delete('/api/resources/:id', staff, async (req, res) => {
  try {
    const r = req.user.role === 'tutor'
      ? await pool.query('DELETE FROM rise_resources WHERE id=$1 AND created_by=$2', [req.params.id, req.user.id])
      : await pool.query('DELETE FROM rise_resources WHERE id=$1', [req.params.id]);
    if (!r.rowCount) return res.status(403).json({ error: 'You can only delete your own posts.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Day passes for videos ----
// Pass status for the logged-in learner
app.get('/api/pass/me', anyUser, async (req, res) => {
  try {
    if (isStaffRole(req.user.role)) return res.json({ staff: true });
    const act = await pool.query(
      "SELECT expires_at FROM rise_passes WHERE user_id=$1 AND status='active' AND expires_at>NOW() ORDER BY expires_at DESC LIMIT 1",
      [req.user.id]
    );
    const pen = await pool.query(
      "SELECT reference FROM rise_passes WHERE user_id=$1 AND status='pending' ORDER BY requested_at DESC LIMIT 1",
      [req.user.id]
    );
    res.json({
      active: !!act.rowCount,
      expiresAt: act.rowCount ? act.rows[0].expires_at : null,
      pending: pen.rowCount ? { reference: pen.rows[0].reference } : null,
      price: PASS_PRICE,
      hours: PASS_HOURS,
      instructions: PAY_INSTRUCTIONS
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// A learner asks for a day pass. It starts only after an admin confirms the payment.
app.post('/api/pass/request', anyUser, async (req, res) => {
  try {
    if (isStaffRole(req.user.role))
      return res.status(400).json({ error: 'Staff do not need a pass.' });

    const act = await pool.query(
      "SELECT 1 FROM rise_passes WHERE user_id=$1 AND status='active' AND expires_at>NOW()",
      [req.user.id]
    );
    if (act.rowCount) return res.status(400).json({ error: 'You already have an active day pass.' });

    const pen = await pool.query("SELECT reference FROM rise_passes WHERE user_id=$1 AND status='pending'", [req.user.id]);
    if (pen.rowCount) return res.json({ ok: true, reference: pen.rows[0].reference });

    const reference = 'RISE-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    await pool.query(
      'INSERT INTO rise_passes(id,user_id,reference,amount) VALUES($1,$2,$3,$4)',
      [id(), req.user.id, reference, PASS_PRICE]
    );
    res.json({ ok: true, reference });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ADMIN ONLY: see the day pass requests and confirm or reject them
app.get('/api/admin/passes', adminOnly, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.id,p.reference,p.status,p.amount,p.requested_at AS "requestedAt",p.expires_at AS "expiresAt",u.name,u.email
      FROM rise_passes p JOIN rise_users u ON u.id=p.user_id
      WHERE p.status='pending' OR (p.status='active' AND p.expires_at>NOW()) OR p.requested_at>NOW()-INTERVAL '7 days'
      ORDER BY CASE p.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, p.requested_at DESC
      LIMIT 200`);
    res.json({ passes: r.rows, price: PASS_PRICE, hours: PASS_HOURS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/passes/:id', adminOnly, async (req, res) => {
  try {
    const a = req.body.action;
    let r;
    if (a === 'confirm') {
      r = await pool.query(
        "UPDATE rise_passes SET status='active',activated_at=NOW(),expires_at=NOW()+($2::int*INTERVAL '1 hour') WHERE id=$1 AND status='pending'",
        [req.params.id, PASS_HOURS]);
    } else if (a === 'reject') {
      r = await pool.query("UPDATE rise_passes SET status='rejected' WHERE id=$1 AND status='pending'", [req.params.id]);
    } else if (a === 'revoke') {
      r = await pool.query("UPDATE rise_passes SET status='revoked',expires_at=NOW() WHERE id=$1 AND status='active'", [req.params.id]);
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }
    if (!r.rowCount) return res.status(409).json({ error: 'That request has already been handled.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Sharing report (ADMIN ONLY) ----
// Learners who opened videos from many different internet addresses or devices within one pass period
app.get('/api/admin/sharing', adminOnly, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT u.id,u.name,u.email,
             COUNT(*)::int AS views,
             COUNT(DISTINCT l.ip)::int AS ips,
             COUNT(DISTINCT l.ua)::int AS devices,
             MAX(l.at) AS "lastAt"
      FROM rise_video_log l JOIN rise_users u ON u.id=l.user_id
      WHERE l.at > NOW() - ($1::int * INTERVAL '1 hour')
      GROUP BY u.id,u.name,u.email
      ORDER BY COUNT(DISTINCT l.ip) DESC, COUNT(DISTINCT l.ua) DESC, COUNT(*) DESC
      LIMIT 200`, [PASS_HOURS]);
    const rows = r.rows.map(x => ({ ...x, flagged: x.ips >= SHARE_MAX_IPS || x.devices >= SHARE_MAX_DEVICES }));
    res.json({
      learners: rows,
      flagged: rows.filter(x => x.flagged).length,
      hours: PASS_HOURS, maxIps: SHARE_MAX_IPS, maxDevices: SHARE_MAX_DEVICES
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The last 60 video openings for one learner
app.get('/api/admin/sharing/:userId', adminOnly, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT l.at,l.ip,l.ua,COALESCE(rs.title,'(deleted video)') AS title
      FROM rise_video_log l LEFT JOIN rise_resources rs ON rs.id=l.resource_id
      WHERE l.user_id=$1 ORDER BY l.at DESC LIMIT 60`, [req.params.userId]);
    res.json({ log: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stop all of a learner's active passes at once
app.patch('/api/admin/sharing/:userId/revoke', adminOnly, async (req, res) => {
  try {
    await pool.query(
      "UPDATE rise_passes SET status='revoked',expires_at=NOW() WHERE user_id=$1 AND status='active'",
      [req.params.userId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================= COMPETITIONS (Physics, Accounting, Maths) =================
const COMP_SUBJECTS = ['Physics', 'Accounting', 'Maths'];
const COMP_FEE = Number(process.env.COMP_FEE) > 0 ? Number(process.env.COMP_FEE) : 150; // rand, paid to the same account as day passes

async function ensureComp() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rise_comp_regs(
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES rise_users(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      school_name TEXT, school_data TEXT,
      rise_name TEXT, rise_data TEXT,
      reference TEXT NOT NULL,
      amount NUMERIC(8,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      decided_at TIMESTAMPTZ,
      UNIQUE(user_id, subject)
    );
    CREATE TABLE IF NOT EXISTS rise_comp_papers(
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      total INTEGER NOT NULL,
      due TIMESTAMPTZ NOT NULL,
      file_name TEXT, file_data TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS rise_comp_subs(
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL REFERENCES rise_comp_papers(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES rise_users(id) ON DELETE CASCADE,
      text TEXT DEFAULT '',
      file_name TEXT, file_data TEXT,
      submitted_at TIMESTAMPTZ DEFAULT NOW(),
      mark INTEGER,
      feedback TEXT DEFAULT '',
      marked_at TIMESTAMPTZ,
      UNIQUE(paper_id, user_id)
    );
  `);
}

// Approved learners only
async function learnerOnly(req, res, next) {
  try {
    const x = await pool.query(
      "SELECT id,name FROM rise_users WHERE id=$1 AND role='learner' AND status='approved'",
      [req.headers['x-admin-id']]
    );
    if (!x.rowCount) return res.status(403).json({ error: 'Learners only. Please log in again.' });
    req.user = x.rows[0];
    next();
  } catch (e) {
    next(e);
  }
}
const okFile = f => f && typeof f.name === 'string' && typeof f.data === 'string' && f.data.length > 20;

// ---- Learner: competition account ----
app.get('/api/comp/me', learnerOnly, async (req, res) => {
  try {
    const regs = await pool.query(
      'SELECT id,subject,status,reference,amount,created_at AS "at" FROM rise_comp_regs WHERE user_id=$1 ORDER BY created_at DESC',
      [req.user.id]);
    const papers = await pool.query(
      `SELECT p.id,p.subject,p.title,p.description AS "desc",p.total,p.due,p.file_name,p.file_data
       FROM rise_comp_papers p
       WHERE p.subject IN (SELECT subject FROM rise_comp_regs WHERE user_id=$1 AND status='approved')
       ORDER BY p.created_at DESC`, [req.user.id]);
    const subs = await pool.query(
      'SELECT id,paper_id AS pid,text,file_name,file_data,submitted_at AS "at",mark,feedback FROM rise_comp_subs WHERE user_id=$1',
      [req.user.id]);
    res.json({
      subjects: COMP_SUBJECTS, fee: COMP_FEE, instructions: PAY_INSTRUCTIONS,
      regs: regs.rows, papers: papers.rows.map(withFile), subs: subs.rows.map(withFile)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/comp/register', learnerOnly, async (req, res) => {
  try {
    const { subject, schoolReport, riseReport } = req.body;
    if (!COMP_SUBJECTS.includes(subject))
      return res.status(400).json({ error: 'Choose Physics, Accounting or Maths.' });
    if (!okFile(schoolReport) || !okFile(riseReport))
      return res.status(400).json({ error: 'Upload both your school report and your RISE COLLECTIVE marks report.' });

    const ex = await pool.query('SELECT status FROM rise_comp_regs WHERE user_id=$1 AND subject=$2', [req.user.id, subject]);
    if (ex.rowCount && ex.rows[0].status !== 'rejected')
      return res.status(409).json({ error: 'You already registered for ' + subject + '.' });
    if (ex.rowCount) await pool.query('DELETE FROM rise_comp_regs WHERE user_id=$1 AND subject=$2', [req.user.id, subject]);

    const reference = 'COMP-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    await pool.query(
      'INSERT INTO rise_comp_regs(id,user_id,subject,school_name,school_data,rise_name,rise_data,reference,amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id(), req.user.id, subject, schoolReport.name, schoolReport.data, riseReport.name, riseReport.data, reference, COMP_FEE]
    );
    res.json({ ok: true, reference });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/comp/submit', learnerOnly, async (req, res) => {
  try {
    const { pid, text, file } = req.body;
    const p = await pool.query('SELECT subject,due FROM rise_comp_papers WHERE id=$1', [pid]);
    if (!p.rowCount) return res.status(404).json({ error: 'Paper not found.' });
    const ok = await pool.query(
      "SELECT 1 FROM rise_comp_regs WHERE user_id=$1 AND subject=$2 AND status='approved'",
      [req.user.id, p.rows[0].subject]);
    if (!ok.rowCount) return res.status(403).json({ error: 'You are not approved for this competition.' });
    if (new Date() > new Date(p.rows[0].due))
      return res.status(403).json({ error: 'Submission closed. The deadline has passed.' });
    const old = await pool.query('SELECT mark FROM rise_comp_subs WHERE paper_id=$1 AND user_id=$2', [pid, req.user.id]);
    if (old.rowCount && old.rows[0].mark != null)
      return res.status(403).json({ error: 'This paper has already been marked.' });

    await pool.query(
      `INSERT INTO rise_comp_subs(id,paper_id,user_id,text,file_name,file_data,submitted_at)
       VALUES($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT(paper_id,user_id) DO UPDATE
       SET text=EXCLUDED.text,file_name=EXCLUDED.file_name,file_data=EXCLUDED.file_data,submitted_at=NOW()`,
      [id(), pid, req.user.id, text || '', file?.name || null, file?.data || null]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Admin + lecturers: set papers and see marks ONLY ----
app.get('/api/comp/papers', admin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.id,p.subject,p.title,p.description AS "desc",p.total,p.due,p.file_name,p.file_data,
              (SELECT COUNT(*) FROM rise_comp_subs s WHERE s.paper_id=p.id)::int AS subs
       FROM rise_comp_papers p ORDER BY p.created_at DESC`);
    res.json({ papers: r.rows.map(withFile), subjects: COMP_SUBJECTS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/comp/papers', admin, async (req, res) => {
  try {
    const { subject, title, desc, total, due, file } = req.body;
    if (!COMP_SUBJECTS.includes(subject)) return res.status(400).json({ error: 'Invalid subject.' });
    if (!title || !(+total > 0)) return res.status(400).json({ error: 'Title and total marks are required.' });
    let dueStr = String(due || '').trim().replace(' ', 'T');
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(dueStr)) {
      if (/T\d{2}:\d{2}$/.test(dueStr)) dueStr += ':00';
      dueStr += '+02:00'; // South African time
    }
    if (isNaN(new Date(dueStr))) return res.status(400).json({ error: 'Invalid deadline.' });
    await pool.query(
      'INSERT INTO rise_comp_papers(id,subject,title,description,total,due,file_name,file_data,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id(), subject, String(title).slice(0, 200), desc || '', +total, dueStr, file?.name || null, file?.data || null, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/comp/papers/:id', admin, async (req, res) => {
  try {
    await pool.query('DELETE FROM rise_comp_papers WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Marks only: learner name, paper and mark. No emails, reports, payments or submitted work.
app.get('/api/comp/marks', admin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.subject,p.title,p.total,u.name,s.mark
       FROM rise_comp_subs s
       JOIN rise_comp_papers p ON p.id=s.paper_id
       JOIN rise_users u ON u.id=s.user_id
       ORDER BY p.subject,p.title,u.name`);
    res.json({ marks: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- ADMIN ONLY: registrations, approvals and marking ----
app.get('/api/comp/regs', adminOnly, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT r.id,r.subject,r.reference,r.amount,r.status,r.created_at AS "at",
              r.school_name AS "schoolName",r.rise_name AS "riseName",u.name,u.email
       FROM rise_comp_regs r JOIN rise_users u ON u.id=r.user_id
       ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, r.created_at DESC
       LIMIT 500`);
    res.json({ regs: r.rows, fee: COMP_FEE });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/comp/regs/:id/file/:which', adminOnly, async (req, res) => {
  try {
    const w = req.params.which === 'rise' ? 'rise' : 'school';
    const r = await pool.query(`SELECT ${w}_name AS name,${w}_data AS data FROM rise_comp_regs WHERE id=$1`, [req.params.id]);
    if (!r.rowCount || !r.rows[0].data) return res.status(404).json({ error: 'File not found.' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/comp/regs/:id', adminOnly, async (req, res) => {
  try {
    const st = { approve: 'approved', reject: 'rejected' }[req.body.action];
    if (!st) return res.status(400).json({ error: 'Invalid action' });
    const r = await pool.query('UPDATE rise_comp_regs SET status=$1,decided_at=NOW() WHERE id=$2', [st, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Registration not found.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/comp/subs', adminOnly, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.id,s.text,s.file_name,s.file_data,s.submitted_at AS "at",s.mark,s.feedback,
              u.name,p.title,p.subject,p.total
       FROM rise_comp_subs s
       JOIN rise_comp_papers p ON p.id=s.paper_id
       JOIN rise_users u ON u.id=s.user_id
       ORDER BY p.subject,p.title,u.name`);
    res.json({ subs: r.rows.map(withFile) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/comp/subs/:id', adminOnly, async (req, res) => {
  try {
    const t = await pool.query(
      'SELECT p.total FROM rise_comp_subs s JOIN rise_comp_papers p ON p.id=s.paper_id WHERE s.id=$1', [req.params.id]);
    if (!t.rowCount) return res.status(404).json({ error: 'Submission not found.' });
    const m = +req.body.mark;
    if (isNaN(m) || m < 0 || m > t.rows[0].total) return res.status(400).json({ error: 'Mark must be 0–' + t.rows[0].total });
    await pool.query('UPDATE rise_comp_subs SET mark=$1,feedback=$2,marked_at=NOW() WHERE id=$3',
      [Math.round(m), req.body.feedback || '', req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================= APPLICATIONS (learners and junior tutors) =================
const GRADES = ['8', '9', '10', '11', '12'];
const DOC_KEYS = ['report', 'matric', 'transcript', 'idcopy'];

async function ensureApps() {
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS rise_student_seq START WITH 1000000001 MINVALUE 1000000001 MAXVALUE 9999999999;
    CREATE TABLE IF NOT EXISTS rise_applications(
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      cell TEXT NOT NULL,
      sa_id TEXT NOT NULL,
      grade TEXT,
      student_number TEXT UNIQUE,
      docs JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      decided_at TIMESTAMPTZ,
      decided_by TEXT,
      wa_status TEXT,
      wa_at TIMESTAMPTZ,
      user_id TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS rise_app_type_said ON rise_applications(type, sa_id);
    ALTER TABLE rise_users ADD COLUMN IF NOT EXISTS student_number TEXT;
  `);
}

// South African ID number: 13 digits and a valid check digit
function validSaId(s) {
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    let n = +s[i];
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

// Turns 082 123 4567 or +27 82 123 4567 into 27821234567 (the format WhatsApp needs), or null
function waNumber(c) {
  let d = String(c || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '27' + d.slice(1);
  return /^27\d{9}$/.test(d) ? d : null;
}

// At most 10 applications per internet address per hour
const applyHits = new Map();
function applyLimited(ip) {
  const r = applyHits.get(ip);
  if (!r || Date.now() - r.t >= 3600000) { applyHits.set(ip, { n: 1, t: Date.now() }); return false; }
  r.n++;
  return r.n > 10;
}

// WhatsApp Cloud API (Meta). Needs WHATSAPP_TOKEN and WHATSAPP_PHONE_ID in Render.
// With a template name it sends the approved template; without one it sends plain text.
async function sendWhatsApp(to, text, tplName, params) {
  const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) return { sent: false, notSetUp: true };
  const body = tplName
    ? {
        messaging_product: 'whatsapp', to, type: 'template',
        template: {
          name: tplName, language: { code: process.env.WHATSAPP_LANG || 'en' },
          components: [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p) })) }]
        }
      }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } };
  try {
    const r = await fetch('https://graph.facebook.com/v20.0/' + phoneId + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { sent: false, reason: (d.error && d.error.message) || 'WhatsApp error ' + r.status };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

async function notifyApplicant(a, link) {
  const to = waNumber(a.cell);
  if (!to) return 'failed: invalid cell number';
  let text, tplName, params;
  if (a.type === 'learner') {
    text = 'Good day. The application for ' + a.name + ' to RISE COLLECTIVE has been accepted. Student number: ' + a.student_number + '. Please register at ' + link + ' using this student number.';
    tplName = process.env.WHATSAPP_TEMPLATE;
    params = [a.name, a.student_number, link];
  } else {
    text = 'Good day ' + a.name + '. Your tutor application to RISE COLLECTIVE has been accepted. Please register at ' + link + ' using the email you applied with.';
    tplName = process.env.WHATSAPP_TEMPLATE_TUTOR;
    params = [a.name, link];
  }
  const r = await sendWhatsApp(to, text, tplName, params);
  const st = r.sent ? 'sent' : r.notSetUp ? 'not set up' : 'failed: ' + r.reason;
  await pool.query('UPDATE rise_applications SET wa_status=$1,wa_at=NOW() WHERE id=$2', [st.slice(0, 300), a.id]);
  return st;
}

// ---- Public: apply (no login) ----
app.post('/api/apply/learner', async (req, res) => {
  try {
    if (applyLimited(req.ip)) return res.status(429).json({ error: 'Too many applications from this connection. Try again later.' });
    const name = String(req.body.name || '').trim().slice(0, 120);
    const grade = String(req.body.grade || '');
    const saId = String(req.body.saId || '').replace(/\s/g, '');
    const cell = String(req.body.parentCell || '').trim();
    const report = req.body.report;
    if (name.length < 2) return res.status(400).json({ error: 'Enter the learner\'s full name.' });
    if (!GRADES.includes(grade)) return res.status(400).json({ error: 'Choose the grade you are applying for.' });
    if (!waNumber(cell)) return res.status(400).json({ error: 'Enter a valid South African cell number for the parent, for example 082 123 4567.' });
    if (!validSaId(saId)) return res.status(400).json({ error: 'The SA ID number is not valid. It must be 13 digits.' });
    if (!okFile(report)) return res.status(400).json({ error: 'Upload the report from the previous grade.' });

    const ex = await pool.query("SELECT status FROM rise_applications WHERE type='learner' AND sa_id=$1", [saId]);
    if (ex.rowCount && ex.rows[0].status !== 'rejected')
      return res.status(409).json({ error: 'An application with this ID number already exists. Ask the office for your student number.' });
    if (ex.rowCount) await pool.query("DELETE FROM rise_applications WHERE type='learner' AND sa_id=$1", [saId]);

    const sn = (await pool.query("SELECT nextval('rise_student_seq')::text AS n")).rows[0].n;
    await pool.query(
      "INSERT INTO rise_applications(id,type,name,cell,sa_id,grade,student_number,docs) VALUES($1,'learner',$2,$3,$4,$5,$6,$7)",
      [id(), name, cell.slice(0, 30), saId, grade, sn, JSON.stringify({ report: { name: report.name, data: report.data } })]
    );
    res.json({ ok: true, studentNumber: sn });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/apply/tutor', async (req, res) => {
  try {
    if (applyLimited(req.ip)) return res.status(429).json({ error: 'Too many applications from this connection. Try again later.' });
    const name = String(req.body.name || '').trim().slice(0, 120);
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
    const saId = String(req.body.saId || '').replace(/\s/g, '');
    const cell = String(req.body.cell || '').trim();
    const { matric, transcript, idCopy } = req.body;
    if (name.length < 2) return res.status(400).json({ error: 'Enter your full name.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!waNumber(cell)) return res.status(400).json({ error: 'Enter a valid South African cell number, for example 082 123 4567.' });
    if (!validSaId(saId)) return res.status(400).json({ error: 'The SA ID number is not valid. It must be 13 digits.' });
    if (!okFile(matric) || !okFile(transcript) || !okFile(idCopy))
      return res.status(400).json({ error: 'Upload your matric certificate, academic transcript and ID copy.' });

    const used = await pool.query('SELECT 1 FROM rise_users WHERE email=$1', [email]);
    if (used.rowCount) return res.status(409).json({ error: 'This email is already registered on the portal.' });
    const ex = await pool.query(
      "SELECT id,status FROM rise_applications WHERE type='tutor' AND (sa_id=$1 OR LOWER(email)=$2)", [saId, email]);
    if (ex.rows.some(x => x.status !== 'rejected'))
      return res.status(409).json({ error: 'A tutor application with this ID number or email already exists.' });
    for (const x of ex.rows) await pool.query('DELETE FROM rise_applications WHERE id=$1', [x.id]);

    await pool.query(
      "INSERT INTO rise_applications(id,type,name,email,cell,sa_id,docs) VALUES($1,'tutor',$2,$3,$4,$5,$6)",
      [id(), name, email, cell.slice(0, 30), saId, JSON.stringify({
        matric: { name: matric.name, data: matric.data },
        transcript: { name: transcript.name, data: transcript.data },
        idcopy: { name: idCopy.name, data: idCopy.data }
      })]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Admins and lecturers: review applications ----
app.get('/api/admin/applications', admin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id,type,name,email,cell,sa_id AS "saId",grade,student_number AS "studentNumber",status,
              created_at AS "at",wa_status AS "waStatus",(user_id IS NOT NULL) AS registered,
              ARRAY(SELECT jsonb_object_keys(docs)) AS "docKeys"
       FROM rise_applications
       ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END, created_at DESC
       LIMIT 500`);
    res.json({ applications: r.rows.map(x => ({ ...x, waNumber: waNumber(x.cell) })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/applications/:id/doc/:key', admin, async (req, res) => {
  try {
    if (!DOC_KEYS.includes(req.params.key)) return res.status(400).json({ error: 'Invalid document.' });
    const r = await pool.query('SELECT docs -> $2::text AS d FROM rise_applications WHERE id=$1', [req.params.id, req.params.key]);
    if (!r.rowCount || !r.rows[0].d) return res.status(404).json({ error: 'Document not found.' });
    res.json(r.rows[0].d);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/applications/:id', admin, async (req, res) => {
  try {
    const action = req.body.action;
    const q = await pool.query('SELECT * FROM rise_applications WHERE id=$1', [req.params.id]);
    if (!q.rowCount) return res.status(404).json({ error: 'Application not found.' });
    const a = q.rows[0];
    const link = req.protocol + '://' + req.get('host');

    if (action === 'accept') {
      await pool.query("UPDATE rise_applications SET status='accepted',decided_at=NOW(),decided_by=$2 WHERE id=$1", [a.id, req.user.id]);
      const wa = await notifyApplicant(a, link);
      return res.json({ ok: true, whatsapp: wa });
    }
    if (action === 'reject') {
      if (a.user_id) return res.status(409).json({ error: 'This applicant has already registered.' });
      await pool.query("UPDATE rise_applications SET status='rejected',decided_at=NOW(),decided_by=$2 WHERE id=$1", [a.id, req.user.id]);
      return res.json({ ok: true });
    }
    if (action === 'resend') {
      if (a.status !== 'accepted') return res.status(409).json({ error: 'Only accepted applications can be notified.' });
      const wa = await notifyApplicant(a, link);
      return res.json({ ok: true, whatsapp: wa });
    }
    res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

init()
  .then(() => ensureComp())
  .then(() => ensureApps())
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log('RISE COLLECTIVE running on ' + PORT)))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
