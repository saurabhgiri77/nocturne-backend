const router = require('express').Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Friendship = require('../models/Friendship');
const Message = require('../models/Message');
const EmailVerification = require('../models/EmailVerification');
const PasswordReset = require('../models/PasswordReset');
const BannedGuest = require('../models/BannedGuest');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../lib/mailer');
const { block: blockToken } = require('../lib/tokenBlocklist');
const verifyToken = require('../middleware/verifyToken');
const {
  loginLimiter,
  registerLimiter,
  googleLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
} = require('../middleware/rateLimit');

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });

// Guest tokens carry the device signals + age attestation. Short-lived so
// abandoned sessions don't pile up cap counters on the server; can be
// re-issued by the same fingerprint with no friction (unless they're banned).
const GUEST_SESSION_MS = 15 * 60 * 1000; // 15 minutes
const GUEST_MAX_MATCHES_PER_SESSION = 3;
const signGuestToken = (claims) =>
  jwt.sign(
    { guest: true, ...claims },
    process.env.JWT_SECRET,
    { expiresIn: Math.floor(GUEST_SESSION_MS / 1000) }
  );

// Public-shape serialization. Centralized so /register, /login, /google,
// /me, and PATCH /me always return the same fields.
const serializeUser = (user, extras = {}) => ({
  id: user._id,
  email: user.email,
  username: user.username || null,
  displayName: user.displayName || null,
  bio: user.bio || null,
  dateOfBirth: user.dateOfBirth || null,
  country: user.country || null,
  languages: Array.isArray(user.languages) ? user.languages : [],
  interests: Array.isArray(user.interests) ? user.interests : [],
  emailVerified: !!user.emailVerified,
  // Frontend uses these to nag before the deadline (show countdown) and to
  // switch to a hard "verify to continue" screen once it passes.
  verificationDeadline: user.verificationDeadline || null,
  emailVerificationRequired:
    typeof user.isVerificationRequired === 'function'
      ? user.isVerificationRequired()
      : false,
  // Only included if currently suspended in the future. Frontend reads this
  // to show the "suspended until X" banner.
  suspendedUntil:
    user.suspendedUntil && user.suspendedUntil > new Date()
      ? user.suspendedUntil
      : null,
  ...extras,
});

// Counts unaccepted friend requests targeting this user. Surfaced in
// serializeUser so the profile-menu badge can stay accurate without a
// dedicated endpoint.
const fetchPendingFriendCount = async (userId) => {
  try {
    return await Friendship.countDocuments({ recipient: userId, status: 'pending' });
  } catch {
    return 0;
  }
};

// Unread DMs targeting this user. Same pattern as the friend-count badge.
const fetchUnreadMessageCount = async (userId) => {
  try {
    return await Message.countDocuments({ to: userId, readAt: null });
  } catch {
    return 0;
  }
};

// Bundles both counts so the auth handlers stay one-liners.
const fetchUserCounts = async (userId) => ({
  pendingFriendCount: await fetchPendingFriendCount(userId),
  unreadMessageCount: await fetchUnreadMessageCount(userId),
});

// Where the frontend lives — needed to build /verify/:token links in the
// email body. Falls back to the first ALLOWED_ORIGINS entry if FRONTEND_URL
// isn't set, since that's the deployed origin in 99% of cases.
const frontendBase = () =>
  process.env.FRONTEND_URL ||
  (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)[0] ||
  '';

// Mint a fresh email-verification token, persist it, and send the email.
// Old unused tokens for the same user are flushed so a "Resend" doesn't
// leave a trail of valid links. Failure to actually send (SMTP issues)
// is logged but doesn't bubble up — the user can hit "Resend" later.
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

const issueAndSendVerification = async (user) => {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
  // Invalidate any prior unused tokens — only the freshest one works.
  await EmailVerification.deleteMany({ user: user._id, used: false });
  await EmailVerification.create({ user: user._id, token, expiresAt });
  const base = frontendBase();
  if (!base) {
    console.warn('[mailer] FRONTEND_URL / ALLOWED_ORIGINS not set — skipping verification email');
    return;
  }
  const link = `${base.replace(/\/$/, '')}/verify/${token}`;
  // Fire-and-forget. The HTTP response shouldn't block on Gmail's SMTP
  // handshake — the token is already in the DB, so the user can retry
  // via /verify/send if delivery fails. Errors still get logged.
  sendVerificationEmail({ to: user.email, link }).catch((err) => {
    console.error('[mailer] verification send failed:', err.message);
  });
};

// Best-effort IP → country lookup using ip-api.com (free, no auth, 45 req/min).
// Returns ISO 3166-1 alpha-2 code or null. Skips loopback / private IPs.
// Never throws — caller should treat null as "unknown".
const detectCountryFromIP = async (ip) => {
  if (!ip) return null;
  // Strip IPv6-mapped IPv4 prefix that Node sometimes attaches.
  const clean = ip.replace(/^::ffff:/, '');
  if (clean === '127.0.0.1' || clean === '::1' || clean.startsWith('10.') || clean.startsWith('192.168.')) {
    return null;
  }
  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(clean)}?fields=countryCode`,
      { signal: AbortSignal.timeout(2000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.countryCode === 'string' && /^[A-Z]{2}$/.test(data.countryCode)) {
      return data.countryCode;
    }
    return null;
  } catch {
    return null;
  }
};

// Languages stored as BCP-47 short codes (e.g. 'en', 'hi'). Allow letters
// and an optional region tag, capped at 8 chars. Server doesn't enforce a
// closed list — frontend picks from a curated set, but we don't want to
// reject niche codes if added later.
const LANGUAGE_CODE_RE = /^[a-z]{2,3}(-[A-Z0-9]{2,3})?$/;
const MAX_LANGUAGES = 5;

// Interests are a CLOSED set — we want every user picking from the same
// vocabulary so the queue doesn't fragment on case / typos. Mirror this
// list in the frontend's constants/interests.js (any drift would just mean
// the new code rejects with 400, which is fine).
const INTEREST_CODES = new Set([
  'music', 'gaming', 'movies', 'anime', 'books', 'sports', 'fitness', 'travel',
  'cooking', 'art', 'photography', 'tech', 'coding', 'science', 'philosophy',
  'language_exchange', 'study', 'pets', 'nature', 'fashion', 'meditation',
  'writing', 'dance', 'memes', 'cars', 'design', 'gardening', 'comedy',
  'finance', 'crypto',
]);
const MAX_INTERESTS = 5;

// Returns a 403 response shaped so the frontend can show a suspension banner.
const respondSuspended = (res, user) =>
  res.status(403).json({
    message: 'Your account is suspended.',
    suspendedUntil: user.suspendedUntil,
  });

// Minimum age to sign up. Mirror this in the frontend's constants/policy.js.
const MIN_AGE_YEARS = 18;

// Generic, non-leaky 500 helper. Logs the real error server-side; returns a
// stable shape to the client so we don't expose stack traces or library messages.
const handle500 = (res, label, err) => {
  console.error(`[${label}]`, err);
  return res.status(500).json({ message: 'Server error' });
};

// Coerce request-body strings to actual primitive strings so a malicious
// client can't smuggle a Mongo operator object (e.g. {"email": {"$ne": null}})
// into a findOne/findById call.
const asString = (v) => (typeof v === 'string' ? v : '');

// Light email-shape sanity. Real email validation is impossible in regex;
// this just rejects obvious junk + caps length.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isEmailish = (s) => typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s);

const ageInYears = (dob) => {
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age;
};

router.post('/register', registerLimiter, async (req, res) => {
  try {
    const email = asString(req.body.email).toLowerCase().trim();
    const password = asString(req.body.password);
    const usernameRaw = asString(req.body.username).toLowerCase().trim();
    const dateOfBirth = req.body.dateOfBirth;

    // Required fields
    if (!email || !password)
      return res.status(400).json({ message: 'Email and password required' });
    if (!isEmailish(email))
      return res.status(400).json({ message: 'Invalid email' });
    if (!usernameRaw) return res.status(400).json({ message: 'Username required' });
    if (!dateOfBirth) return res.status(400).json({ message: 'Date of birth required' });
    if (password.length < 6)
      return res.status(400).json({ message: 'Min 6 chars' });
    if (password.length > 200)
      return res.status(400).json({ message: 'Password too long' });

    // Username format
    if (!User.USERNAME_REGEX.test(usernameRaw)) {
      return res.status(400).json({
        message: 'Username must be 3–20 chars: lowercase letters, digits, _ or .',
      });
    }

    // DOB + age
    const dob = new Date(asString(dateOfBirth) || dateOfBirth);
    if (Number.isNaN(dob.getTime())) {
      return res.status(400).json({ message: 'Invalid date of birth' });
    }
    const age = ageInYears(dob);
    if (age < MIN_AGE_YEARS) {
      return res.status(400).json({ message: `You must be at least ${MIN_AGE_YEARS} years old to sign up` });
    }
    if (age > 120) {
      return res.status(400).json({ message: 'Invalid date of birth' });
    }

    // Uniqueness checks (queries get string scalars, not objects)
    if (await User.findOne({ email }))
      return res.status(409).json({ message: 'Email already registered' });
    if (await User.findOne({ username: usernameRaw }))
      return res.status(409).json({ message: 'Username taken' });

    // Best-effort IP-geo. Failures (timeout, rate limit, private IP) leave
    // country null; user can fill it in from ProfileEditModal later.
    const country = await detectCountryFromIP(req.ip);

    const user = new User({
      email,
      passwordHash: password,
      username: usernameRaw,
      dateOfBirth: dob,
      country: country || undefined,
      // emailVerified defaults to false — verification email follows. The
      // user can use Bump until this deadline, then must verify (gated by
      // socket auth + requireVerified). Google signups skip this (verified).
      verificationDeadline: new Date(Date.now() + User.VERIFICATION_GRACE_MS),
    });
    await user.save();

    // Fire-and-forget the verification email. Don't block the response on
    // SMTP latency; the user can hit "Resend" if it never arrives.
    issueAndSendVerification(user).catch((err) =>
      console.error('[register] verification dispatch failed:', err.message)
    );

    res.status(201).json({
      token: signToken(user._id),
      user: serializeUser(user, await fetchUserCounts(user._id)),
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'Email or username already registered' });
    }
    return handle500(res, 'auth/register', err);
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const email = asString(req.body.email).toLowerCase().trim();
    const password = asString(req.body.password);

    if (!email || !password)
      return res.status(400).json({ message: 'Email and password required' });
    if (!isEmailish(email))
      return res.status(401).json({ message: 'Invalid credentials' });

    const user = await User.findOne({ email });
    if (!user)
      return res.status(401).json({ message: 'Invalid credentials' });

    const ok = await user.comparePassword(password);
    if (!ok)
      return res.status(401).json({ message: 'Invalid credentials' });

    if (user.isSuspended()) return respondSuspended(res, user);

    res.status(200).json({
      token: signToken(user._id),
      user: serializeUser(user, await fetchUserCounts(user._id)),
    });
  } catch (err) {
    return handle500(res, 'auth/login', err);
  }
});

router.post('/google', googleLimiter, async (req, res) => {
  try {
    const accessToken = asString(req.body.accessToken);
    if (!accessToken)
      return res.status(400).json({ message: 'Google access token required' });

    const expectedAud = process.env.GOOGLE_CLIENT_ID;

    // Verify the token's audience matches our OAuth client. Without this,
    // an attacker could replay an access token issued for a different
    // OAuth client (token sidejacking — V4 from the security audit).
    //
    // If GOOGLE_CLIENT_ID isn't set, we warn loudly and skip the check
    // rather than 500. This keeps OAuth functional during initial deploys
    // before the operator has set the env var, while still printing a
    // nag in logs that gets fixed in prod.
    if (expectedAud) {
      const tokenInfoRes = await fetch(
        `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
      );
      if (!tokenInfoRes.ok)
        return res.status(401).json({ message: 'Invalid Google token' });
      const tokenInfo = await tokenInfoRes.json();
      if (tokenInfo.aud !== expectedAud) {
        console.warn('[auth/google] aud mismatch', { got: tokenInfo.aud });
        return res.status(401).json({ message: 'Invalid Google token' });
      }
    } else {
      console.warn(
        '[auth/google] GOOGLE_CLIENT_ID not set — skipping audience verification. ' +
        'OAuth is open to token sidejacking until you set this env var. ' +
        'See server/routes/auth.js for context.'
      );
    }

    // Fetch the userinfo (email + sub).
    const googleRes = await fetch(
      `https://www.googleapis.com/oauth2/v3/userinfo`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!googleRes.ok)
      return res.status(401).json({ message: 'Invalid Google token' });

    const { sub: googleId, email } = await googleRes.json();
    if (!googleId || !isEmailish(email))
      return res.status(401).json({ message: 'Invalid Google token' });

    let user = await User.findOne({ googleId });
    if (!user) {
      user = await User.findOne({ email });
      if (user) {
        user.googleId = googleId;
        await user.save();
      } else {
        // Net-new account via Google. Same best-effort IP-geo as /register.
        // Google has already verified the email address, so we mark
        // emailVerified=true immediately — no separate verification needed.
        const country = await detectCountryFromIP(req.ip);
        user = await User.create({
          email,
          googleId,
          country: country || undefined,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        });
      }
    }

    if (user.isSuspended()) return respondSuspended(res, user);

    res.status(200).json({
      token: signToken(user._id),
      user: serializeUser(user, await fetchUserCounts(user._id)),
    });
  } catch (err) {
    console.error('[auth/google]', err);
    return res.status(401).json({ message: 'Google authentication failed' });
  }
});

router.get('/me', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.isSuspended()) return respondSuspended(res, user);
    res.json({ user: serializeUser(user, await fetchUserCounts(user._id)) });
  } catch (err) {
    return handle500(res, 'auth/me', err);
  }
});

router.patch('/me', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (req.body.username !== undefined) {
      const u = asString(req.body.username).toLowerCase().trim();
      if (!User.USERNAME_REGEX.test(u)) {
        return res.status(400).json({
          message: 'Username must be 3–20 chars: lowercase letters, digits, _ or .',
        });
      }
      if (u !== user.username) {
        const taken = await User.findOne({ username: u, _id: { $ne: user._id } });
        if (taken) return res.status(409).json({ message: 'Username taken' });
        user.username = u;
      }
    }

    if (req.body.displayName !== undefined) {
      const d = asString(req.body.displayName).trim();
      if (d.length > 50) return res.status(400).json({ message: 'Display name too long (max 50)' });
      user.displayName = d || undefined;
    }

    if (req.body.bio !== undefined) {
      const b = asString(req.body.bio).trim();
      if (b.length > 200) return res.status(400).json({ message: 'Bio too long (max 200)' });
      user.bio = b || undefined;
    }

    if (req.body.dateOfBirth !== undefined) {
      const d = new Date(asString(req.body.dateOfBirth) || req.body.dateOfBirth);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ message: 'Invalid date of birth' });
      const age = ageInYears(d);
      if (age < MIN_AGE_YEARS) return res.status(400).json({ message: `Must be at least ${MIN_AGE_YEARS} years old` });
      if (age > 120) return res.status(400).json({ message: 'Invalid date of birth' });
      user.dateOfBirth = d;
    }

    if (req.body.country !== undefined) {
      const c = asString(req.body.country).toUpperCase().trim();
      if (c === '') {
        user.country = undefined;
      } else if (!/^[A-Z]{2}$/.test(c)) {
        return res.status(400).json({ message: 'Country must be a 2-letter ISO code' });
      } else {
        user.country = c;
      }
    }

    if (req.body.languages !== undefined) {
      if (!Array.isArray(req.body.languages)) {
        return res.status(400).json({ message: 'Languages must be an array' });
      }
      const cleaned = [...new Set(
        req.body.languages
          .filter((l) => typeof l === 'string')
          .map((l) => l.trim())
          .filter(Boolean)
      )];
      if (cleaned.length > MAX_LANGUAGES) {
        return res.status(400).json({ message: `Pick at most ${MAX_LANGUAGES} languages` });
      }
      for (const code of cleaned) {
        if (!LANGUAGE_CODE_RE.test(code)) {
          return res.status(400).json({ message: `Invalid language code: ${code}` });
        }
      }
      user.languages = cleaned.length > 0 ? cleaned : undefined;
    }

    if (req.body.interests !== undefined) {
      if (!Array.isArray(req.body.interests)) {
        return res.status(400).json({ message: 'Interests must be an array' });
      }
      const cleaned = [...new Set(
        req.body.interests
          .filter((i) => typeof i === 'string')
          .map((i) => i.trim().toLowerCase())
          .filter(Boolean)
      )];
      if (cleaned.length > MAX_INTERESTS) {
        return res.status(400).json({ message: `Pick at most ${MAX_INTERESTS} interests` });
      }
      for (const code of cleaned) {
        if (!INTEREST_CODES.has(code)) {
          return res.status(400).json({ message: `Unknown interest: ${code}` });
        }
      }
      user.interests = cleaned.length > 0 ? cleaned : undefined;
    }

    await user.save();
    res.json({ user: serializeUser(user, await fetchUserCounts(user._id)) });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Username taken' });
    return handle500(res, 'auth/patch-me', err);
  }
});

// POST /api/auth/logout — invalidates the bearer token by adding its
// fingerprint to the in-memory blocklist until natural expiry. Without this
// step a stolen token stays valid for the full JWT TTL (7d).
router.post('/logout', verifyToken, async (req, res) => {
  try {
    // req.user.exp is unix-seconds. Convert to ms.
    const expiresAtMs = (req.user.exp || Math.floor(Date.now() / 1000) + 60) * 1000;
    blockToken(req.token, expiresAtMs);
    res.json({ ok: true });
  } catch (err) {
    return handle500(res, 'auth/logout', err);
  }
});

// POST /api/auth/verify/send — re-issue a verification token + send email.
// Auth-required so a stranger can't trigger emails to arbitrary inboxes.
// 60s cooldown per user prevents spamming our SMTP quota / their inbox.
const VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;
router.post('/verify/send', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.emailVerified) return res.status(400).json({ message: 'Email already verified' });

    // Cooldown: refuse if a token was issued for this user in the last 60s.
    const recent = await EmailVerification.findOne({ user: user._id })
      .sort({ createdAt: -1 })
      .lean();
    if (recent && Date.now() - new Date(recent.createdAt).getTime() < VERIFICATION_RESEND_COOLDOWN_MS) {
      const retryAfter = Math.ceil(
        (VERIFICATION_RESEND_COOLDOWN_MS - (Date.now() - new Date(recent.createdAt).getTime())) / 1000
      );
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        message: `Please wait ${retryAfter}s before requesting another email.`,
        retryAfter,
      });
    }

    await issueAndSendVerification(user);
    res.json({ ok: true });
  } catch (err) {
    return handle500(res, 'auth/verify-send', err);
  }
});

// POST /api/auth/verify — token IS the auth here (no Bearer required). User
// got the token by clicking the email link, so possessing it proves email
// ownership. Token single-use, expires in 24h.
router.post('/verify', async (req, res) => {
  try {
    const token = asString(req.body.token);
    if (!token || token.length < 16) {
      return res.status(400).json({ message: 'Invalid token' });
    }
    const record = await EmailVerification.findOne({ token, used: false });
    if (!record) return res.status(400).json({ message: 'Invalid or already-used token' });
    if (record.expiresAt < new Date()) {
      return res.status(400).json({ message: 'Token expired — request a new one' });
    }
    const user = await User.findById(record.user);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (!user.emailVerified) {
      user.emailVerified = true;
      user.emailVerifiedAt = new Date();
      await user.save();
    }
    record.used = true;
    await record.save();

    res.json({ ok: true });
  } catch (err) {
    return handle500(res, 'auth/verify', err);
  }
});

// Password reset flow. Two routes:
//   POST /forgot — takes an email, emails a reset link if the account exists.
//                  Always returns 200 (anti-enumeration); only the email body
//                  reveals whether the account exists.
//   POST /reset  — takes a token + new password, updates the hash.
//
// Tokens are 64-hex-char random, single-use, expire in 1h. Old unused tokens
// for the same user get flushed on every /forgot so a new request invalidates
// any prior link. Tokens live in PasswordReset (Mongo TTL on expiresAt).
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

router.post('/forgot', forgotPasswordLimiter, async (req, res) => {
  try {
    const email = asString(req.body.email).toLowerCase().trim();
    if (!email || !isEmailish(email)) {
      return res.status(400).json({ message: 'Invalid email' });
    }

    // Find user but DON'T leak existence in the response. Spec: always 200.
    const user = await User.findOne({ email });
    if (user && user.passwordHash) {
      // Google-only accounts (no passwordHash) can't reset — they sign in
      // via Google. Silently skip the email; user still gets a 200.
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
      // Invalidate any prior unused tokens — only the freshest link works.
      await PasswordReset.deleteMany({ user: user._id, used: false });
      await PasswordReset.create({ user: user._id, token, expiresAt });

      const base = frontendBase();
      if (base) {
        const link = `${base.replace(/\/$/, '')}/reset/${token}`;
        // Fire-and-forget — HTTP response shouldn't block on SMTP latency.
        sendPasswordResetEmail({ to: user.email, link }).catch((err) => {
          console.error('[mailer] password-reset send failed:', err.message);
        });
      } else {
        console.warn('[mailer] FRONTEND_URL not set — skipping reset email');
      }
    }

    // Constant response regardless of whether the email matched a user.
    res.json({ ok: true });
  } catch (err) {
    return handle500(res, 'auth/forgot', err);
  }
});

router.post('/reset', resetPasswordLimiter, async (req, res) => {
  try {
    const token = asString(req.body.token);
    const password = asString(req.body.password);

    if (!token || token.length < 16) {
      return res.status(400).json({ message: 'Invalid token' });
    }
    if (!password) return res.status(400).json({ message: 'Password required' });
    if (password.length < 6) return res.status(400).json({ message: 'Min 6 chars' });
    if (password.length > 200) return res.status(400).json({ message: 'Password too long' });

    const record = await PasswordReset.findOne({ token, used: false });
    if (!record) return res.status(400).json({ message: 'Invalid or already-used link' });
    if (record.expiresAt < new Date()) {
      return res.status(400).json({ message: 'Link expired — request a new one' });
    }
    const user = await User.findById(record.user);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Setting passwordHash to a plaintext string triggers the pre('save')
    // hook on User, which bcrypts it before persisting.
    user.passwordHash = password;
    // Marks any JWT issued before now as invalid — see verifyToken middleware
    // and socket auth. Crucial when reset is used because the account was
    // compromised: forces every other session to re-authenticate.
    user.passwordChangedAt = new Date();
    await user.save();
    record.used = true;
    await record.save();

    res.json({ ok: true });
  } catch (err) {
    return handle500(res, 'auth/reset', err);
  }
});

// POST /api/auth/guest — issue an anonymous JWT for landing-page visitors who
// want to try the app without signing up. Accepts a DOB attestation (must be
// ≥ MIN_AGE_YEARS) plus the device fingerprint + uuid produced by
// utils/fingerprint.js on the client. Checks the BannedGuest collection
// using the two-of-three signal rule (fpHash / uuid / ip).
//
// The returned token is short-lived (GUEST_SESSION_MS) and carries the
// fingerprint so downstream code (matchmaking caps, report → ban path)
// always knows which device this is.
router.post('/guest', async (req, res) => {
  try {
    const fpHash = asString(req.body.fpHash).slice(0, 64);
    const uuid   = asString(req.body.uuid).slice(0, 64);
    const dobStr = asString(req.body.dateOfBirth);
    const ip = req.ip || '';

    if (!fpHash || !uuid) {
      return res.status(400).json({ message: 'Device fingerprint missing.' });
    }
    if (!dobStr) {
      return res.status(400).json({ message: 'Please enter your date of birth.' });
    }
    const dob = new Date(dobStr);
    if (Number.isNaN(dob.getTime())) {
      return res.status(400).json({ message: 'Invalid date of birth.' });
    }
    const age = ageInYears(dob);
    if (age < MIN_AGE_YEARS) {
      return res.status(400).json({ message: `You must be at least ${MIN_AGE_YEARS} to use Bump.` });
    }
    if (age > 120) {
      return res.status(400).json({ message: 'Invalid date of birth.' });
    }

    // Banned? two-of-three signal match returns the offending row.
    const banned = await BannedGuest.matchesAny(fpHash, uuid, ip).catch(() => null);
    if (banned) {
      return res.status(403).json({ message: 'Guest access is not available from this device.' });
    }

    // gid is a fresh per-session id used as socket.user.id and report target.
    const gid = `guest_${crypto.randomBytes(12).toString('hex')}`;
    const token = signGuestToken({
      id: gid,
      gid,
      fp: fpHash,
      uuid,
      adult: true,
      dobYear: dob.getFullYear(),
    });

    res.json({
      token,
      sessionMs: GUEST_SESSION_MS,
      maxMatches: GUEST_MAX_MATCHES_PER_SESSION,
      guest: {
        id: gid,
        guest: true,
        username: null,
        displayName: null,
        email: null,
        emailVerified: false,
      },
    });
  } catch (err) {
    return handle500(res, 'auth/guest', err);
  }
});

module.exports = router;
