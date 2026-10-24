app.post('/api/assessments', admin, async (req, res) => {
  try {
    const { title, desc, total, due, file } = req.body;

    // Deadlines typed by the lecturer are South African time (UTC+2, no daylight saving).
    // If the browser sent no time zone, add +02:00 so the time is stored exactly as typed.
    let dueStr = String(due || '').trim().replace(' ', 'T');
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(dueStr)) {
      if (/T\d{2}:\d{2}$/.test(dueStr)) dueStr += ':00';
      dueStr += '+02:00';
    }
    if (isNaN(new Date(dueStr)))
      return res.status(400).json({ error: 'Invalid deadline.' });

    const x = id();
    await pool.query(
      'INSERT INTO rise_assessments(id,title,description,total,due,file_name,file_data) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [x, title, desc || '', +total, dueStr, file?.name || null, file?.data || null]
    );
    res.json({ ok: true, id: x });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
