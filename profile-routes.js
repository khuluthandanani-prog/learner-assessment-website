// Staff profile routes (admin, lecturer, junior tutor):
// picture, description, gender and number of learners under their subjects.
// Hooked into server.js with one line:  require('./profile-routes')(app, pool);
module.exports = function (app, pool) {
  const GENDERS = ['Female', 'Male', 'Other', 'Prefer not to say'];

  // Adds the three profile columns once, the first time a profile is opened.
  let ready = null;
  const ensure = () => {
    if (!ready) {
      ready = pool.query(
        `ALTER TABLE rise_users
           ADD COLUMN IF NOT EXISTS photo TEXT,
           ADD COLUMN IF NOT EXISTS bio TEXT,
           ADD COLUMN IF NOT EXISTS gender TEXT`
      ).catch(e => { ready = null; throw e; });
    }
    return ready;
  };

  // Only approved admins, lecturers and junior tutors can use these routes.
  async function staffOnly(req, res, next) {
    try {
      const x = await pool.query(
        "SELECT id,role FROM rise_users WHERE id=$1 AND role IN ('admin','lecturer','tutor') AND status='approved'",
        [String(req.headers['x-admin-id'] || '')]
      );

      if (!x.rowCount) return res.status(403).json({ error: 'Access denied' });

      await ensure();
      req.staffUser = x.rows[0];
      next();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }

  app.get('/api/profile/me', staffOnly, async (req, res) => {
    try {
      const u = await pool.query(
        'SELECT name,email,role,photo,bio,gender,subjects FROM rise_users WHERE id=$1',
        [req.staffUser.id]
      );

      const me = u.rows[0];
      const all = me.role === 'admin' || me.role === 'lecturer';

      // Approved learners in each subject
      const per = await pool.query(
        `SELECT s AS subject, COUNT(*)::int AS n
         FROM rise_users u, unnest(u.subjects) AS s
         WHERE u.role='learner' AND u.status='approved'
         GROUP BY s
         ORDER BY s`
      );

      const byName = {};
      per.rows.forEach(r => { byName[r.subject] = r.n; });

      const mine = all
        ? per.rows.map(r => r.subject)
        : (me.subjects || []);

      // Distinct learners across the person's subjects (a learner in two subjects counts once)
      const tot = all
        ? await pool.query("SELECT COUNT(*)::int AS n FROM rise_users WHERE role='learner' AND status='approved'")
        : await pool.query(
            "SELECT COUNT(*)::int AS n FROM rise_users WHERE role='learner' AND status='approved' AND subjects && $1::text[]",
            [mine]
          );

      res.json({
        name: me.name,
        email: me.email,
        role: me.role,
        photo: me.photo || null,
        bio: me.bio || '',
        gender: me.gender || '',
        genders: GENDERS,
        subjects: mine.map(s => ({ name: s, learners: byName[s] || 0 })),
        allSubjects: all,
        totalLearners: tot.rows[0].n
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch('/api/profile/me', staffOnly, async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [];
      const vals = [req.staffUser.id];

      if (b.bio !== undefined) {
        vals.push(String(b.bio || '').trim().slice(0, 1000));
        sets.push('bio=$' + vals.length);
      }

      if (b.gender !== undefined) {
        const g = String(b.gender || '');
        if (g && !GENDERS.includes(g)) {
          return res.status(400).json({ error: 'Choose a gender from the list.' });
        }
        vals.push(g || null);
        sets.push('gender=$' + vals.length);
      }

      if (b.photo !== undefined) {
        if (b.photo === null || b.photo === '') {
          vals.push(null);
        } else {
          const p = String(b.photo);
          if (!/^data:image\/(jpeg|png|webp);base64,/.test(p)) {
            return res.status(400).json({ error: 'The picture must be a JPEG, PNG or WebP image.' });
          }
          if (p.length > 1500000) {
            return res.status(400).json({ error: 'The picture is too large. Choose a smaller one.' });
          }
          vals.push(p);
        }
        sets.push('photo=$' + vals.length);
      }

      if (!sets.length) return res.status(400).json({ error: 'Nothing to save.' });

      await pool.query('UPDATE rise_users SET ' + sets.join(',') + ' WHERE id=$1', vals);

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
