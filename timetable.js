// Weekly timetable. Only the secret admin can add, change or clear it (same rule as applications).
// Learners, parents, tutors, lecturers and admins can look at it.
module.exports = function (ctx) {
  const { app, pool, anyUser, secretAdminOnly, canDecideApps, id } = ctx;

  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS rise_timetable(
      id TEXT PRIMARY KEY,
      day INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      title TEXT NOT NULL,
      subject TEXT,
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(e => console.error('timetable table:', e.message));

  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
  const setting = (k, v) => pool.query(
    'INSERT INTO rise_settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v]);
  const touch = () => setting('timetable_updated', new Date().toISOString());

  // Returns { error } or { v } with the cleaned entry
  function clean(b) {
    const day = parseInt(b.day, 10);
    const start = String(b.start || '').trim();
    const end = String(b.end || '').trim();
    const title = String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const subject = String(b.subject || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const note = String(b.note || '').trim().slice(0, 300);
    if (!(day >= 1 && day <= 7)) return { error: 'Choose the day.' };
    if (!TIME.test(start) || !TIME.test(end)) return { error: 'Enter the start and end times.' };
    if (end <= start) return { error: 'The end time must be after the start time.' };
    if (title.length < 2) return { error: 'Enter what is happening in this time slot.' };
    return { v: { day, start, end, title, subject, note } };
  }

  // Everyone who is logged in can look
  app.get('/api/timetable', anyUser, async (req, res) => {
    try {
      await ready;
      const r = await pool.query(
        `SELECT id,day,start_time AS start,end_time AS "end",title,subject,note
         FROM rise_timetable ORDER BY day,start_time,end_time`);
      const s = await pool.query("SELECT key,value FROM rise_settings WHERE key IN ('timetable_note','timetable_updated')");
      const m = {};
      s.rows.forEach(x => { m[x.key] = x.value; });
      res.set('Cache-Control', 'no-store');
      res.json({
        entries: r.rows,
        weekNote: m.timetable_note || '',
        updatedAt: m.timetable_updated || null,
        canEdit: await canDecideApps(req.user)
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Only the secret admin from here on
  app.post('/api/timetable', secretAdminOnly, async (req, res) => {
    try {
      await ready;
      const c = clean(req.body || {});
      if (c.error) return res.status(400).json({ error: c.error });
      const v = c.v;
      await pool.query(
        'INSERT INTO rise_timetable(id,day,start_time,end_time,title,subject,note) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id(), v.day, v.start, v.end, v.title, v.subject || null, v.note]);
      await touch();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // The message above the week (for example "Week of 17 November: maths test on Friday")
  app.patch('/api/timetable/note', secretAdminOnly, async (req, res) => {
    try {
      await ready;
      await setting('timetable_note', String((req.body && req.body.note) || '').trim().slice(0, 500));
      await touch();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/timetable/:id', secretAdminOnly, async (req, res) => {
    try {
      await ready;
      const c = clean(req.body || {});
      if (c.error) return res.status(400).json({ error: c.error });
      const v = c.v;
      const r = await pool.query(
        'UPDATE rise_timetable SET day=$2,start_time=$3,end_time=$4,title=$5,subject=$6,note=$7 WHERE id=$1',
        [req.params.id, v.day, v.start, v.end, v.title, v.subject || null, v.note]);
      if (!r.rowCount) return res.status(404).json({ error: 'Entry not found.' });
      await touch();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Clear the whole week (to start the next week fresh)
  app.delete('/api/timetable', secretAdminOnly, async (req, res) => {
    try {
      await ready;
      await pool.query('DELETE FROM rise_timetable');
      await touch();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/timetable/:id', secretAdminOnly, async (req, res) => {
    try {
      await ready;
      await pool.query('DELETE FROM rise_timetable WHERE id=$1', [req.params.id]);
      await touch();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
