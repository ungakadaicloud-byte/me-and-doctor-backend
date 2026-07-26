Me & Doctor — Backend (Phase 1 MVP)
Express + Supabase backend for the Me & Doctor (Clinic OS) product — a true clinic operating system for solo doctors and small clinics with one assistant.
Setup
npm install
cp .env.example .env   # fill in Supabase, Wati, Razorpay values
Create a new, dedicated Supabase project for Me & Doctor.
Run the migrations in order in the Supabase SQL editor: 001_init.sql → 002_patient_profile_and_followups.sql → 003_full_phase1_mvp.sql.
Deploy this repo to a new, dedicated Railway service (do not share infra with other "Me &" products).
Point WATI_* and RAZORPAY_* env vars at the existing shared accounts (reused, not new accounts, per the locked decision).
Structure
packages/auth-core — session token verification (Supabase Auth mints the sessions themselves via magic link email), nested inside this repo (Railway only builds repo contents, same pattern as Me & Coach)
src/routes/auth.js — send-otp / verify-otp / dev-login, supplies this product's single-role resolveClaims (doctor only, no branching)
src/routes/clinic.js — Clinic Settings (doctor/clinic identity, registration number, fee, timings, logo, prescription header)
src/routes/patients.js — registration, search (name/mobile/today's token), and the complete patient timeline in one call
src/routes/visits.js — chief complaint, diagnosis, notes, follow-up date (auto-creates reminders), visit status
src/routes/prescriptions.js — medicines, advice, printable PDF, WhatsApp share
src/routes/queue.js — waiting / in_consultation / completed / cancelled
src/routes/billing.js — itemized fees, discount, payment status/method, invoice number
src/routes/dashboard.js — today's stats in one call
src/routes/reports.js — daily collection/patient trend, pending payments list
src/routes/webhooks.js — Razorpay payment.captured handler
src/cron/reminders.js — daily 8am job sending due follow-up reminders via Wati
migrations/ — run in numeric order; full schema + RLS policies (every table scoped by clinic_id from the JWT)
Phase 1 MVP — complete
This backend implements the full approved Phase 1 MVP:
Patients: full registration (name, mobile, gender, DOB/age, address, blood group, allergies, chronic conditions, emergency contact, notes), search by name/mobile/today's-token-number
Patient Timeline: GET /api/patients/:id returns the doctor's complete digital memory in one call — visits, prescriptions, bills, and follow-up history together
Visits: chief complaint, diagnosis, clinical notes, follow-up date (auto-creates the reminders row), visit status (completed/cancelled)
Prescriptions: medicines (free-text), advice, printable PDF (uses Clinic Settings' registration number + custom prescription header when set), WhatsApp share wired and ready (activates once a Wati template is approved)
Queue: waiting → in_consultation → completed, plus cancelled
Billing: itemized consultation fee + other charges − discount = total, payment status (pending/paid), payment method (cash/UPI/card/razorpay), invoice number
Dashboard: today's patients, walk-ins, completed visits, upcoming follow-ups, pending payments, today's revenue, recent patients — one GET /api/dashboard call
Reports: GET /api/reports/daily (7-day patient/collection trend) and GET /api/reports/pending-payments
Clinic Settings: doctor name, qualification, registration number, clinic name/address/phone, consultation fee, timings, logo URL, prescription header
Notes / deliberately out of scope
These remain out of Phase 1 by explicit decision, not oversight — revisit only if beta feedback demands it:
Staff/Assistant role — single doctor login only, no multi-user RBAC
Appointment booking — walk-in queue only, no scheduled appointments
Offline-first — requires network connectivity
ABDM compliance — not requested by target doctors yet
Multi-location — one clinic per doctor account
Also: prescriptions.medicines is free-text JSONB (no drug database) — enables "repeat last prescription" as a simple copy. Dev-login route is triple-gated (NODE_ENV + DEV_LOGIN_ENABLED + DEV_LOGIN_SECRET header) and returns 404 in any other configuration.
Production hardening pass (post-audit)
Note: the items below describe the MSG91 SMS OTP flow as it existed at the time. Login has since moved to Supabase Auth magic-link email — see the "Auth migration" section further down for the current setup. Left as-is here since it's an accurate record of that pass.
Following a full source-code audit, these were implemented directly on the existing codebase — no architecture change, no new repository:
Doctor onboarding — POST /api/auth/onboard (previously completely missing; the only way to add a clinic was manual SQL). Reuses the same MSG91 Widget phone verification as login, creates clinics + doctors together, rolls back the clinic row if the doctor insert fails, and logs the new doctor straight in.
Race conditions fixed — queue_tokens.token_number and visit_billing.invoice_number both used a count()-then-insert() pattern with no atomicity guarantee. Replaced with next_daily_counter() / next_clinic_counter() Postgres functions (migration 004) — a single atomic INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING statement that can't collide under concurrent requests.
Invoice PDF — GET /api/billing/:id/pdf, previously missing (only prescriptions had a PDF route). Same pdfkit pattern, itemized fee breakdown, invoice number, payment status.
Lab/Test recommendations — new visits.lab_tests column + form field, previously entirely absent.
CORS locked down — was cors() with no options (wide open); now restricted to FRONTEND_URL origins when NODE_ENV=production.
Rate limiting added — express-rate-limit: strict limiter on /api/auth/* (20 req/15min — OTP/onboarding are abuse-prone), looser general limiter on the rest of /api (300 req/15min).
Dead code removed — the legacy direct-API /api/auth/send-otp and /api/auth/verify-otp routes (superseded by the Widget flow months ago, but still present and unused) and their corresponding auth-core functions are gone. MSG91_TEMPLATE_ID removed from .env.example since nothing reads it anymore.
Basic input validation added — negative billing totals rejected, invalid payment_status rejected, 404s returned consistently where a row isn't found (some PATCH routes previously returned 200 with null on a not-found ID instead of 404).
Auth migration: MSG91 SMS OTP → Supabase Auth (magic link email)
Login no longer goes through this backend at all — the frontend talks to Supabase Auth directly (supabase.auth.signInWithOtp) to send/verify the magic link. This backend's role is now just:
packages/auth-core — trimmed to only requireSession (JWT verification). Supabase's own tokens are signed with the same SUPABASE_JWT_SECRET, so verification is unchanged; only the claims shape differs (native sub/email, no custom clinic_id).
src/middleware/auth.js (withClinicAuth) — resolves clinic_id with one extra RLS-scoped lookup against doctors.auth_user_id, since it's no longer embedded in the token as a custom claim. Returns 403 { error: 'no_clinic_for_user' } for a logged-in user who hasn't onboarded yet.
src/routes/auth.js — now only POST /api/auth/onboard (creates clinics + doctors, linked to the session's auth_user_id). All MSG91-specific code, the legacy send-otp/verify-otp routes, verify-widget-token, and dev-login are gone.
Migration 005_supabase_email_auth.sql — adds doctors.auth_user_id, makes doctors.phone optional, and replaces every table's RLS policy with a current_clinic_id() helper function instead of a custom JWT claim.
MSG91_AUTH_KEY removed from .env.example — nothing in this backend calls MSG91 anymore. (Wati, a separate WhatsApp service, is unaffected and still used for reminders/prescription sharing.)


