const { createClient } = require('@supabase/supabase-js');

// Validates tokens by asking Supabase who they belong to, rather than
// verifying the signature locally with a shared secret.
//
// The previous implementation did jwt.verify(token, SUPABASE_JWT_SECRET),
// which assumes Supabase signs with a symmetric HS256 secret. Projects
// on Supabase's newer API-key system (anon keys that look like
// `sb_publishable_...`) sign access tokens asymmetrically instead, so
// that verification fails for *every* request — the backend returns 401
// on all authenticated calls even though the session is perfectly valid.
// getUser() works regardless of the signing algorithm in use.
const adminClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function requireSession(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'missing_token' });
  }

  try {
    const { data, error } = await adminClient.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    // Keeps the same shape downstream code already expects: claims.sub
    // is the auth user id used to resolve the doctor's clinic.
    req.claims = { sub: data.user.id, email: data.user.email, role: data.user.role };
    req.userToken = token;
    next();
  } catch (err) {
    console.error('Token validation failed:', err.message);
    return res.status(401).json({ error: 'invalid_token' });
  }
}

module.exports = { requireSession };
