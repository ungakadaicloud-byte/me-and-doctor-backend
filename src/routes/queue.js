const express = require('express');
const { withClinicAuth } = require('../middleware/auth');

const router = express.Router();
router.use(withClinicAuth);

function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

router.get('/today', async (req, res) => {
  const { start, end } = todayRange();

  const { data, error } = await req.supabase
    .from('queue_tokens')
    .select('*, patients(name, phone)')
    .eq('clinic_id', req.clinicId)
    .gte('created_at', start)
    .lte('created_at', end)
    .order('token_number', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/token', async (req, res) => {
  const { patient_id } = req.body;

  // Race-condition fix: next_daily_counter() is a single atomic
  // Postgres statement (INSERT ... ON CONFLICT ... DO UPDATE ...
  // RETURNING), so two tokens issued in the same instant can never
  // collide on token_number — the old count-then-insert pattern could.
  const { data: tokenNumber, error: counterError } = await req.supabase
    .rpc('next_daily_counter', { p_clinic_id: req.clinicId, p_counter_type: 'queue_token' });

  if (counterError) return res.status(500).json({ error: counterError.message });

  const { data, error } = await req.supabase
    .from('queue_tokens')
    .insert({
      clinic_id: req.clinicId,
      patient_id: patient_id || null,
      token_number: tokenNumber,
      status: 'waiting',
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/token/:id', async (req, res) => {
  const { status, vitals } = req.body;
  const updates = {};

  if (status !== undefined) {
    if (!['waiting', 'in_consultation', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'invalid_status' });
    }
    updates.status = status;
  }

  // Lets an assistant/nurse record BP/Sugar/Weight while the patient is
  // still waiting — independent of status changes, since the same
  // request may only be updating vitals (not moving the queue state).
  if (vitals !== undefined) {
    updates.vitals = vitals;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'nothing_to_update' });
  }

  const { data, error } = await req.supabase
    .from('queue_tokens')
    .update(updates)
    .eq('id', req.params.id)
    .eq('clinic_id', req.clinicId)
    .select()
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'not_found' });
  res.json(data);
});

module.exports = router;
