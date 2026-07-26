const express = require('express');
const { withClinicAuth } = require('../middleware/auth');

const router = express.Router();
router.use(withClinicAuth);

const PATIENT_FIELDS = [
  'name', 'phone', 'age', 'gender', 'date_of_birth', 'address',
  'blood_group', 'allergies', 'chronic_conditions', 'emergency_contact', 'notes',
];

function pick(body, fields) {
  return fields.reduce((acc, f) => {
    if (body[f] !== undefined) acc[f] = body[f];
    return acc;
  }, {});
}

// Search supports: name, phone (Mobile Number), and today's token number.
// Token-number search looks up today's queue_tokens first, then returns
// the matching patients — a token isn't a patient field, so it can't be
// searched with the same `q` ilike as name/phone.
router.get('/', async (req, res) => {
  const { q, limit, token } = req.query;

  if (token) {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);

    const { data: tokenRows, error: tokenError } = await req.supabase
      .from('queue_tokens')
      .select('patient_id')
      .eq('clinic_id', req.clinicId)
      .eq('token_number', Number(token))
      .gte('created_at', start.toISOString())
      .lte('created_at', end.toISOString());

    if (tokenError) return res.status(500).json({ error: tokenError.message });
    const patientIds = (tokenRows || []).map((t) => t.patient_id).filter(Boolean);
    if (!patientIds.length) return res.json([]);

    const { data, error } = await req.supabase.from('patients').select('*').in('id', patientIds);
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  }

  let query = req.supabase.from('patients').select('*').eq('clinic_id', req.clinicId);
  if (q) query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%`);
  query = query.order('created_at', { ascending: false });
  if (limit) query = query.limit(Number(limit));

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/', async (req, res) => {
  const fields = pick(req.body, PATIENT_FIELDS);
  if (!fields.name) return res.status(400).json({ error: 'name_required' });

  const { data, error } = await req.supabase
    .from('patients')
    .insert({ clinic_id: req.clinicId, ...fields })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/:id', async (req, res) => {
  const fields = pick(req.body, PATIENT_FIELDS);
  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'nothing_to_update' });
  }
  fields.updated_at = new Date().toISOString();

  const { data, error } = await req.supabase
    .from('patients')
    .update(fields)
    .eq('id', req.params.id)
    .eq('clinic_id', req.clinicId)
    .select()
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// The doctor's complete digital memory for this patient: visits (with
// diagnosis/chief complaint/status), prescriptions, bills, follow-up
// history, and payment history — all in one call so the timeline page
// doesn't need to make five separate requests.
router.get('/:id', async (req, res) => {
  const { data: patient, error: patientError } = await req.supabase
    .from('patients')
    .select('*')
    .eq('id', req.params.id)
    .eq('clinic_id', req.clinicId)
    .maybeSingle();

  if (patientError) return res.status(500).json({ error: patientError.message });
  if (!patient) return res.status(404).json({ error: 'not_found' });

  const { data: visitRows, error: visitsError } = await req.supabase
    .from('visits')
    .select('*')
    .eq('patient_id', req.params.id)
    .order('visit_date', { ascending: false })
    .limit(20);

  if (visitsError) return res.status(500).json({ error: visitsError.message });
  const visitIds = (visitRows || []).map((v) => v.id);

  const [prescriptions, bills, reminders] = await Promise.all([
    req.supabase.from('prescriptions').select('*').eq('patient_id', req.params.id).order('created_at', { ascending: false }).limit(20),
    visitIds.length
      ? req.supabase.from('visit_billing').select('*').in('visit_id', visitIds).order('created_at', { ascending: false }).limit(20)
      : Promise.resolve({ data: [] }),
    req.supabase.from('reminders').select('*').eq('patient_id', req.params.id).order('send_date', { ascending: false }).limit(20),
  ]);

  res.json({
    ...patient,
    recent_visits: visitRows || [],
    prescriptions: prescriptions.data || [],
    bills: bills.data || [],
    follow_up_history: reminders.data || [],
  });
});

module.exports = router;
