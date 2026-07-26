const express = require('express');
const { withClinicAuth } = require('../middleware/auth');

const router = express.Router();
router.use(withClinicAuth);

router.post('/', async (req, res) => {
  const { patient_id, chief_complaint, soap_notes, diagnosis, lab_tests, vitals, follow_up_date, status } = req.body;
  if (!patient_id) return res.status(400).json({ error: 'patient_id_required' });

  const { data, error } = await req.supabase
    .from('visits')
    .insert({
      clinic_id: req.clinicId,
      patient_id,
      visit_date: new Date().toISOString(),
      chief_complaint: chief_complaint || null,
      soap_notes: soap_notes || null,
      diagnosis: diagnosis || null,
      lab_tests: lab_tests || null,
      vitals: vitals || {},
      follow_up_date: follow_up_date || null,
      status: status || 'completed',
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Missing link fixed in Phase 1.1: creating a visit with a follow-up
  // date actually creates the reminder row the cron job depends on.
  if (follow_up_date) {
    const { error: reminderError } = await req.supabase.from('reminders').insert({
      clinic_id: req.clinicId,
      patient_id,
      type: 'follow_up',
      send_date: follow_up_date,
    });
    if (reminderError) console.error('follow-up reminder insert failed:', reminderError.message);
  }

  res.status(201).json(data);
});

const EDITABLE_VISIT_FIELDS = ['chief_complaint', 'soap_notes', 'diagnosis', 'lab_tests', 'vitals', 'follow_up_date', 'status'];

router.patch('/:id', async (req, res) => {
  const updates = {};
  for (const field of EDITABLE_VISIT_FIELDS) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

  if (updates.status && !['completed', 'cancelled'].includes(updates.status)) {
    return res.status(400).json({ error: 'invalid_status' });
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'nothing_to_update' });
  }

  // Lets a doctor correct a typo'd diagnosis or a wrong vitals reading
  // after the visit is saved — previously only the status could be
  // changed, so any mistake in the actual clinical notes was permanent.
  updates.updated_at = new Date().toISOString();

  const { data, error } = await req.supabase
    .from('visits')
    .update(updates)
    .eq('id', req.params.id)
    .eq('clinic_id', req.clinicId)
    .select()
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'not_found' });
  res.json(data);
});

router.get('/patient/:patientId', async (req, res) => {
  const { data, error } = await req.supabase
    .from('visits')
    .select('*')
    .eq('patient_id', req.params.patientId)
    .order('visit_date', { ascending: false })
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
