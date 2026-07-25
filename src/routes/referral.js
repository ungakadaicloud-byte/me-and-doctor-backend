const express = require('express');
const PDFDocument = require('pdfkit');
const { withClinicAuth } = require('../middleware/auth');

const router = express.Router();
router.use(withClinicAuth);

// Referral letters are generated on-the-fly and not persisted — there's
// no ongoing "referral record" a solo clinic needs to track (the visit
// itself already has the diagnosis on file); this just needs to produce
// a letterhead document for the patient to carry to the specialist.
router.post('/pdf', async (req, res) => {
  const { patient_id, referred_to, specialty, reason } = req.body;
  if (!patient_id || !referred_to) {
    return res.status(400).json({ error: 'patient_id_and_referred_to_required' });
  }

  const [{ data: patient, error: patientError }, { data: clinic, error: clinicError }] = await Promise.all([
    req.supabase.from('patients').select('name, age, gender').eq('id', patient_id).maybeSingle(),
    req.supabase.from('clinics').select('clinic_name, doctor_name, qualification, clinic_address, registration_number').eq('id', req.clinicId).maybeSingle(),
  ]);

  if (patientError || !patient) return res.status(404).json({ error: 'patient_not_found' });
  if (clinicError || !clinic) return res.status(404).json({ error: 'clinic_not_found' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename=referral-${patient_id}.pdf`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  doc.fontSize(16).text(clinic.clinic_name, { align: 'center' });
  doc.fontSize(10).text(`${clinic.doctor_name} — ${clinic.qualification || ''}`, { align: 'center' });
  if (clinic.registration_number) doc.text(`Reg. No: ${clinic.registration_number}`, { align: 'center' });
  doc.text(clinic.clinic_address || '', { align: 'center' });
  doc.moveDown(2);

  doc.fontSize(12).text(`Date: ${new Date().toLocaleDateString()}`);
  doc.moveDown();
  doc.text(`To,`);
  doc.text(`${referred_to}${specialty ? ` (${specialty})` : ''}`);
  doc.moveDown();

  doc.text('Sub: Patient Referral');
  doc.moveDown();

  doc.text(
    `This is to refer ${patient.name} (${patient.age || '-'} yrs / ${patient.gender || '-'}) for further evaluation and management` +
    (reason ? `, in view of: ${reason}.` : '.')
  );
  doc.moveDown(2);

  doc.text('Kindly examine and manage as deemed appropriate. Please feel free to reach out for any further clinical information.');
  doc.moveDown(3);

  doc.text('Regards,');
  doc.moveDown(2);
  doc.text(`${clinic.doctor_name}`);
  doc.text(`${clinic.qualification || ''}`);

  doc.end();
});

module.exports = router;
