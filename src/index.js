require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const clinicRoutes = require('./routes/clinic');
const patientRoutes = require('./routes/patients');
const visitRoutes = require('./routes/visits');
const prescriptionRoutes = require('./routes/prescriptions');
const queueRoutes = require('./routes/queue');
const billingRoutes = require('./routes/billing');
const reminderRoutes = require('./routes/reminders');
const dashboardRoutes = require('./routes/dashboard');
const reportsRoutes = require('./routes/reports');
const referralRoutes = require('./routes/referral');
const webhookRoutes = require('./routes/webhooks');
const { startReminderCron } = require('./cron/reminders');

const app = express();

// Razorpay webhook needs the raw body for signature verification,
// so it's mounted BEFORE the json() body parser.
app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);

// CORS: restricted to the configured frontend origin(s) rather than
// the previous wide-open cors() with no options. FRONTEND_URL supports
// a comma-separated list (e.g. production + a Vercel preview URL).
// Falls back to allow-all only outside production, for local dev.
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (process.env.NODE_ENV !== 'production') return callback(null, true);
    if (!origin) return callback(null, true); // server-to-server / curl / webhooks
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
}));

app.use(express.json());

// Rate limiting: a strict limiter on auth endpoints (OTP send/verify
// and onboarding are the most abuse-prone — SMS-bombing, brute force),
// and a looser general limiter on everything else under /api.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api', apiLimiter);
app.use('/api/clinic', clinicRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/visits', visitRoutes);
app.use('/api/prescriptions', prescriptionRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/referral', referralRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Me & Doctor backend listening on port ${PORT}`);
  startReminderCron();
});
