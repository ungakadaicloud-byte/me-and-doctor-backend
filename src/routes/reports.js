const express = require('express');
const { withClinicAuth } = require('../middleware/auth');

const router = express.Router();
router.use(withClinicAuth);

router.get('/pending-payments', async (req, res) => {
  const { data, error } = await req.supabase
    .from('visit_billing')
    .select('*, visits(visit_date, patient_id, patients(name, phone))')
    .eq('clinic_id', req.clinicId)
    .eq('payment_status', 'pending')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Daily Collection + Daily Patients trend over the last N days
// (reuses visits/visit_billing already being collected — no new tables).
router.get('/daily', async (req, res) => {
  const days = Number(req.query.days) || 7;
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);

  const [visits, billing] = await Promise.all([
    req.supabase.from('visits').select('visit_date').eq('clinic_id', req.clinicId).gte('visit_date', start.toISOString()),
    req.supabase.from('visit_billing').select('amount, created_at').eq('clinic_id', req.clinicId).gte('created_at', start.toISOString()),
  ]);

  if (visits.error) return res.status(500).json({ error: visits.error.message });
  if (billing.error) return res.status(500).json({ error: billing.error.message });

  const byDay = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    byDay[key] = { date: key, patients: 0, collection: 0 };
  }

  (visits.data || []).forEach((v) => {
    const key = v.visit_date.slice(0, 10);
    if (byDay[key]) byDay[key].patients += 1;
  });

  (billing.data || []).forEach((b) => {
    const key = b.created_at.slice(0, 10);
    if (byDay[key]) byDay[key].collection += Number(b.amount);
  });

  res.json(Object.values(byDay));
});

// Printable Daily Register — today's queue tokens joined with their
// patient, diagnosis, and billing, in one call. Powers the "Print
// Today's Register" feature — a digital stand-in for the old paper
// register book doctors are used to keeping as a backup record.
router.get('/daily-register', async (req, res) => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(); end.setHours(23, 59, 59, 999);

  const { data: tokens, error: tokensError } = await req.supabase
    .from('queue_tokens')
    .select('token_number, status, created_at, patient_id, patients(name, phone)')
    .eq('clinic_id', req.clinicId)
    .gte('created_at', start.toISOString())
    .lte('created_at', end.toISOString())
    .order('token_number', { ascending: true });

  if (tokensError) return res.status(500).json({ error: tokensError.message });

  const patientIds = (tokens || []).map((t) => t.patient_id).filter(Boolean);

  const [visits, billing] = await Promise.all([
    patientIds.length
      ? req.supabase.from('visits').select('patient_id, diagnosis, visit_date')
          .in('patient_id', patientIds).gte('visit_date', start.toISOString()).lte('visit_date', end.toISOString())
      : Promise.resolve({ data: [] }),
    patientIds.length
      ? req.supabase.from('visit_billing').select('visit_id, amount, payment_status, visits!inner(patient_id)')
          .gte('created_at', start.toISOString()).lte('created_at', end.toISOString())
      : Promise.resolve({ data: [] }),
  ]);

  const diagnosisByPatient = {};
  (visits.data || []).forEach((v) => { diagnosisByPatient[v.patient_id] = v.diagnosis; });

  const billingByPatient = {};
  (billing.data || []).forEach((b) => {
    const pid = b.visits?.patient_id;
    if (!pid) return;
    billingByPatient[pid] = billingByPatient[pid] || { amount: 0, status: 'paid' };
    billingByPatient[pid].amount += Number(b.amount);
    if (b.payment_status === 'pending') billingByPatient[pid].status = 'pending';
  });

  const register = (tokens || []).map((t) => ({
    token_number: t.token_number,
    patient_name: t.patients?.name || 'Walk-in',
    phone: t.patients?.phone || null,
    status: t.status,
    diagnosis: t.patient_id ? diagnosisByPatient[t.patient_id] || null : null,
    amount: t.patient_id ? billingByPatient[t.patient_id]?.amount ?? null : null,
    payment_status: t.patient_id ? billingByPatient[t.patient_id]?.status ?? null : null,
  }));

  res.json(register);
});

module.exports = router;
