// Parent sign-off: a parent opens the learner's marked work and signs it with a selfie taken at that moment.
// Unsigned work is tracked: reminder after SIGN_DAYS, "exclusion due" SIGN_GRACE_DAYS after the reminder. The office decides on exclusion.
module.exports = function (ctx) {
  const { app, pool, anyUser, admin, id } = ctx;
  const num = (v, d) => (parseInt(v, 10) > 0 ? parseInt(v, 10) : d);
  const DAYS = num(process.env.SIGN_DAYS, 7);              // days a parent has to sign marked work
  const GRACE = num(process.env.SIGN_GRACE_DAYS, 7);       // days after the reminder before exclusion is due

  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS rise_signoffs(
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL REFERENCES rise_submissions(id) ON DELETE CASCADE,
      marked_at TIMESTAMPTZ NOT NULL,
      learner_id TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      selfie TEXT NOT NULL,
      ip TEXT,
      ua TEXT,
      signed_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(submission_id, marked_at)
    );
    CREATE TABLE IF NOT EXISTS rise_work_views(
      submission_id TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      marked_at TIMESTAMPTZ,
      at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(submission_id, parent_id)
    );
    CREATE TABLE IF NOT EXISTS rise_signoff_notices(
      learner_id TEXT PRIMARY KEY,
      reminded_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(e => console.error('sign-off tables:', e.message));

  // Work is "unsigned" while no sign-off exists for its CURRENT marking (re-marked work must be signed again)
  const UNSIGNED = `NOT EXISTS (SELECT 1 FROM rise_signoffs g WHERE g.submission_id=s.id AND g.marked_at=s.marked_at)`;

  async function tick() {
    try {
      await ready;
      await pool.query(`
        INSERT INTO rise_signoff_notices(learner_id)
        SELECT DISTINCT s.user_id FROM rise_submissions s
        WHERE s.mark IS NOT NULL AND s.marked_at IS NOT NULL
          AND NOW() > s.marked_at + ($1::int * INTERVAL '1 day') AND ${UNSIGNED}
        ON CONFLICT (learner_id) DO NOTHING`, [DAYS]);
      await pool.query(`
        DELETE FROM rise_signoff_notices n WHERE NOT EXISTS (
          SELECT 1 FROM rise_submissions s WHERE s.user_id=n.learner_id AND s.mark IS NOT NULL AND s.marked_at IS NOT NULL
            AND NOW() > s.marked_at + ($1::int * INTERVAL '1 day') AND ${UNSIGNED})`, [DAYS]);
    } catch (e) { console.error('sign-off check:', e.message); }
  }
  tick();
  setInterval(tick, 5 * 60 * 1000);

  const okSelfie = s => typeof s === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(s) && s.length <= 1500000;

  // The marked work of the learner, with its sign-off status. Parents and learners (the learner can only look).
  app.get('/api/signoff/me', anyUser, async (req, res) => {
    try {
      await ready;
      if (req.user.role !== 'learner') return res.status(403).json({ error: 'Learners and parents only.' });
      const r = await pool.query(`
        SELECT s.id,a.title,a.subject,a.total,s.mark,s.feedback,s.marked_at AS "markedAt",
               s.marked_at + ($2::int * INTERVAL '1 day') AS "dueAt",
               (NOW() > s.marked_at + ($2::int * INTERVAL '1 day')) AS overdue,
               g.signed_at AS "signedAt"
        FROM rise_submissions s
        JOIN rise_assessments a ON a.id=s.assessment_id
        LEFT JOIN rise_signoffs g ON g.submission_id=s.id AND g.marked_at=s.marked_at
        WHERE s.user_id=$1 AND s.mark IS NOT NULL AND s.marked_at IS NOT NULL
        ORDER BY s.marked_at DESC`, [req.user.id, DAYS]);
      const n = await pool.query('SELECT reminded_at FROM rise_signoff_notices WHERE learner_id=$1', [req.user.id]);
      const rem = n.rowCount ? n.rows[0].reminded_at : null;
      res.json({
        isParent: !!req.user.isParent, days: DAYS, graceDays: GRACE,
        unsigned: r.rows.filter(x => !x.signedAt).length,
        reminder: rem, excludeAfter: rem ? new Date(new Date(rem).getTime() + GRACE * 86400000) : null,
        items: r.rows
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // One marked piece of work in full. When a parent opens it, that is recorded: the parent must have seen it before signing.
  app.get('/api/signoff/work/:sid', anyUser, async (req, res) => {
    try {
      await ready;
      if (req.user.role !== 'learner') return res.status(403).json({ error: 'Learners and parents only.' });
      const r = await pool.query(`
        SELECT s.id,a.title,a.subject,a.total,s.mark,s.feedback,s.text,s.file_name,s.file_data,s.marked_at AS "markedAt",
               g.signed_at AS "signedAt"
        FROM rise_submissions s
        JOIN rise_assessments a ON a.id=s.assessment_id
        LEFT JOIN rise_signoffs g ON g.submission_id=s.id AND g.marked_at=s.marked_at
        WHERE s.id=$1 AND s.user_id=$2 AND s.mark IS NOT NULL AND s.marked_at IS NOT NULL`, [req.params.sid, req.user.id]);
      if (!r.rowCount) return res.status(404).json({ error: 'Work not found.' });
      const x = r.rows[0];
      if (req.user.isParent)
        await pool.query(`INSERT INTO rise_work_views(submission_id,parent_id,marked_at) VALUES($1,$2,$3)
                          ON CONFLICT (submission_id,parent_id) DO UPDATE SET marked_at=EXCLUDED.marked_at, at=NOW()`,
          [x.id, req.user.parentId, x.markedAt]);
      res.set('Cache-Control', 'no-store');
      res.json({
        id: x.id, title: x.title, subject: x.subject, total: x.total, mark: x.mark, feedback: x.feedback || '',
        text: x.text || '', file: x.file_name ? { name: x.file_name, data: x.file_data } : null,
        markedAt: x.markedAt, signedAt: x.signedAt, canSign: !!req.user.isParent && !x.signedAt
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // The parent signs: a selfie taken now, after the work has been opened
  app.post('/api/signoff/:sid', anyUser, async (req, res) => {
    try {
      await ready;
      if (!req.user.isParent) return res.status(403).json({ error: 'Only the parent or guardian can sign.' });
      const selfie = req.body && req.body.selfie;
      if (!okSelfie(selfie)) return res.status(400).json({ error: 'Take a clear selfie to sign.' });
      const s = await pool.query('SELECT id,marked_at FROM rise_submissions WHERE id=$1 AND user_id=$2 AND mark IS NOT NULL AND marked_at IS NOT NULL',
        [req.params.sid, req.user.id]);
      if (!s.rowCount) return res.status(404).json({ error: 'Work not found.' });
      const v = await pool.query('SELECT 1 FROM rise_work_views WHERE submission_id=$1 AND parent_id=$2 AND marked_at=$3',
        [req.params.sid, req.user.parentId, s.rows[0].marked_at]);
      if (!v.rowCount) return res.status(400).json({ error: 'Open and read the work before you sign it.' });
      const ins = await pool.query(`INSERT INTO rise_signoffs(id,submission_id,marked_at,learner_id,parent_id,selfie,ip,ua)
                                    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (submission_id,marked_at) DO NOTHING`,
        [id(), req.params.sid, s.rows[0].marked_at, req.user.id, req.user.parentId, selfie,
         String(req.ip || '').slice(0, 64), String(req.headers['user-agent'] || '').slice(0, 200)]);
      if (!ins.rowCount) return res.status(409).json({ error: 'This work is already signed.' });
      tick();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // OFFICE (admins and lecturers): learners with unsigned marked work, and where each one stands
  app.get('/api/admin/signoffs', admin, async (req, res) => {
    try {
      await ready;
      const r = await pool.query(`
        SELECT u.id,u.student_number AS "studentNumber",u.school,u.district,u.province,u.status,
               COUNT(*)::int AS unsigned,
               (COUNT(*) FILTER (WHERE NOW() > s.marked_at + ($1::int * INTERVAL '1 day')))::int AS overdue,
               MIN(s.marked_at) AS oldest, n.reminded_at AS "remindedAt", NOW() AS now,
               EXISTS(SELECT 1 FROM rise_users p WHERE p.role='parent' AND p.learner_id=u.id) AS "parentRegistered"
        FROM rise_users u
        JOIN rise_submissions s ON s.user_id=u.id AND s.mark IS NOT NULL AND s.marked_at IS NOT NULL
        LEFT JOIN rise_signoff_notices n ON n.learner_id=u.id
        WHERE u.role='learner' AND ${UNSIGNED}
        GROUP BY u.id, n.reminded_at
        ORDER BY 6 DESC, 7`, [DAYS]);
      const rows = r.rows.map(x => {
        const now = new Date(x.now);
        let state = 'waiting';
        if (x.overdue > 0) {
          state = !x.remindedAt ? 'overdue'
            : (now > new Date(new Date(x.remindedAt).getTime() + GRACE * 86400000) ? 'exclusion_due' : 'reminded');
        }
        const { now: _n, ...rest } = x;
        return { ...rest, state };
      });
      res.json({ rows, days: DAYS, graceDays: GRACE });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // OFFICE: the selfie from the application next to the selfies taken at signing, to compare by eye
  app.get('/api/admin/signoffs/:learnerId', admin, async (req, res) => {
    try {
      await ready;
      const reg = await pool.query("SELECT docs->'parentselfie'->>'data' AS data FROM rise_applications WHERE user_id=$1 AND type='learner'", [req.params.learnerId]);
      const s = await pool.query(`
        SELECT g.id,g.signed_at AS "signedAt",g.selfie,a.title
        FROM rise_signoffs g JOIN rise_submissions sub ON sub.id=g.submission_id JOIN rise_assessments a ON a.id=sub.assessment_id
        WHERE g.learner_id=$1 ORDER BY g.signed_at DESC LIMIT 8`, [req.params.learnerId]);
      res.json({ registration: reg.rowCount ? reg.rows[0].data : null, signoffs: s.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
