const express = require('express');
const PDFDocument = require('pdfkit');
const { withClinicAuth } = require('../middleware/auth');

const router = express.Router();
router.use(withClinicAuth);

router.post('/', async (req, res) => {
  const {
    visit_id, amount, payment_mode, upi_qr_ref, payment_status,
    consultation_fee, other_charges, discount,
  } = req.body;

  if (!visit_id) return res.status(400).json({ error: 'visit_id_required' });

  // Itemized flow: consultation_fee + other_charges - discount = total.
  // Simple flow: `amount` passed directly, unchanged from Phase 1.1.
  const hasItemized = consultation_fee != null;
  const total = hasItemized
    ? Number(consultation_fee) + Number(other_charges || 0) - Number(discount || 0)
    : amount;

  if (total == null || Number.isNaN(Number(total))) {
    return res.status(400).json({ error: 'amount_or_consultation_fee_required' });
  }
  if (Number(total) < 0) {
    return res.status(400).json({ error: 'total_cannot_be_negative' });
  }

  // Race-condition fix: same atomic-counter pattern as queue tokens,
  // but a lifetime counter (next_clinic_counter) rather than a daily
  // one, since invoice numbers shouldn't reset each day.
  const { data: invoiceNumber, error: counterError } = await req.supabase
    .rpc('next_clinic_counter', { p_clinic_id: req.clinicId, p_counter_type: 'invoice' });

  if (counterError) return res.status(500).json({ error: counterError.message });

  const { data, error } = await req.supabase
    .from('visit_billing')
    .insert({
      clinic_id: req.clinicId,
      visit_id,
      amount: total,
      consultation_fee: consultation_fee ?? null,
      other_charges: other_charges ?? 0,
      discount: discount ?? 0,
      payment_mode,
      upi_qr_ref,
      payment_status: payment_status || (payment_mode === 'razorpay' ? 'pending' : 'paid'),
      invoice_number: invoiceNumber,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/:id', async (req, res) => {
  const { payment_status, payment_mode, consultation_fee, other_charges, discount } = req.body;
  if (payment_status && !['pending', 'paid'].includes(payment_status)) {
    return res.status(400).json({ error: 'invalid_payment_status' });
  }

  const updates = {};
  if (payment_status !== undefined) updates.payment_status = payment_status;
  if (payment_mode !== undefined) updates.payment_mode = payment_mode;

  // Correcting the fee breakdown recomputes the total the same way
  // creating a bill does — a doctor fixing a wrongly-entered discount
  // shouldn't have to delete and recreate the whole invoice.
  const editingAmount = consultation_fee !== undefined || other_charges !== undefined || discount !== undefined;
  if (editingAmount) {
    if (consultation_fee !== undefined) updates.consultation_fee = consultation_fee;
    if (other_charges !== undefined) updates.other_charges = other_charges;
    if (discount !== undefined) updates.discount = discount;

    const { data: existing, error: fetchError } = await req.supabase
      .from('visit_billing')
      .select('consultation_fee, other_charges, discount')
      .eq('id', req.params.id)
      .eq('clinic_id', req.clinicId)
      .maybeSingle();
    if (fetchError) return res.status(500).json({ error: fetchError.message });
    if (!existing) return res.status(404).json({ error: 'not_found' });

    const fee = Number(consultation_fee ?? existing.consultation_fee ?? 0);
    const other = Number(other_charges ?? existing.other_charges ?? 0);
    const disc = Number(discount ?? existing.discount ?? 0);
    const total = fee + other - disc;
    if (Number.isNaN(total) || total < 0) return res.status(400).json({ error: 'invalid_amount' });
    updates.amount = total;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'nothing_to_update' });
  }
  updates.updated_at = new Date().toISOString();

  const { data, error } = await req.supabase
    .from('visit_billing')
    .update(updates)
    .eq('id', req.params.id)
    .eq('clinic_id', req.clinicId)
    .select()
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'not_found' });
  res.json(data);
});

router.get('/summary', async (req, res) => {
  const { range = 'day' } = req.query;
  const now = new Date();
  let start;

  if (range === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  } else {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
  }

  const { data, error } = await req.supabase
    .from('visit_billing')
    .select('id, amount, consultation_fee, other_charges, discount, payment_mode, payment_status, invoice_number, created_at')
    .eq('clinic_id', req.clinicId)
    .gte('created_at', start.toISOString());

  if (error) return res.status(500).json({ error: error.message });

  const total = data.reduce((sum, row) => sum + Number(row.amount), 0);
  res.json({ range, total, count: data.length, rows: data });
});

// Printable invoice PDF — was previously missing (only prescriptions
// had a PDF route). Mirrors the prescriptions.js PDF pattern.
router.get('/:id/pdf', async (req, res) => {
  const { data: bill, error } = await req.supabase
    .from('visit_billing')
    .select('*, visits(visit_date, patients(name, age, gender)), clinics(clinic_name, doctor_name, qualification, clinic_address, registration_number)')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error || !bill) return res.status(404).json({ error: 'not_found' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename=invoice-${bill.invoice_number || bill.id}.pdf`);

  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(res);

  doc.fontSize(16).text(bill.clinics.clinic_name, { align: 'center' });
  doc.fontSize(10).text(`${bill.clinics.doctor_name} — ${bill.clinics.qualification || ''}`, { align: 'center' });
  if (bill.clinics.registration_number) {
    doc.text(`Reg. No: ${bill.clinics.registration_number}`, { align: 'center' });
  }
  doc.text(bill.clinics.clinic_address || '', { align: 'center' });
  doc.moveDown();

  doc.fontSize(14).text(`Invoice #${bill.invoice_number || '-'}`, { align: 'right' });
  doc.fontSize(10).text(`Date: ${new Date(bill.created_at).toLocaleDateString()}`, { align: 'right' });
  doc.moveDown();

  if (bill.visits?.patients) {
    doc.fontSize(12).text(`Patient: ${bill.visits.patients.name}  (${bill.visits.patients.age || '-'} / ${bill.visits.patients.gender || '-'})`);
    doc.moveDown();
  }

  if (bill.consultation_fee != null) {
    doc.fontSize(11).text(`Consultation Fee: ₹${Number(bill.consultation_fee).toFixed(2)}`);
    doc.text(`Other Charges: ₹${Number(bill.other_charges || 0).toFixed(2)}`);
    doc.text(`Discount: -₹${Number(bill.discount || 0).toFixed(2)}`);
    doc.moveDown(0.5);
  }

  doc.fontSize(13).text(`Total: ₹${Number(bill.amount).toFixed(2)}`, { underline: true });
  doc.fontSize(10).text(`Payment Mode: ${bill.payment_mode || '-'}`);
  doc.text(`Payment Status: ${bill.payment_status}`);

  doc.end();
});

module.exports = router;
