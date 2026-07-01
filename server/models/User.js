const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const USERNAME_REGEX = /^[a-z0-9_.]{3,20}$/;

// Unverified accounts may use Bump freely for this long after sign-up, then
// email verification becomes mandatory. A `verificationDeadline` is stamped
// at registration (now + this); once it passes, isVerificationRequired()
// returns true and the socket grace timer + requireVerified middleware gate
// the core experience.
const VERIFICATION_GRACE_MS = 30 * 60 * 1000; // 30 minutes

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String },
    googleId: { type: String, unique: true, sparse: true },

    // Profile fields (#19). username and dateOfBirth become required at the
    // application layer once the user completes onboarding; the schema keeps
    // them sparse-unique / optional so existing accounts don't break before
    // they finish onboarding.
    username: {
      type: String,
      lowercase: true,
      trim: true,
      unique: true,
      sparse: true,
      match: [USERNAME_REGEX, 'Username must be 3-20 chars: lowercase letters, digits, _ or .'],
    },
    displayName: { type: String, trim: true, maxlength: 50 },
    bio: { type: String, trim: true, maxlength: 200 },
    dateOfBirth: { type: Date },

    // ISO 3166-1 alpha-2 (e.g. 'IN'). Auto-detected from IP at signup
    // when possible; user-editable from ProfileEditModal. Display-only —
    // not used for queue filtering.
    country: { type: String, uppercase: true, match: /^[A-Z]{2}$/ },

    // BCP-47 short codes (e.g. 'en', 'hi'). Used for queue bucketing —
    // matchmaking prefers peers with at least one shared language, and
    // falls back to global pairing after 15s.
    languages: { type: [String], default: undefined },

    // Curated lowercase tags (e.g. 'music', 'gaming'). Used as a softer
    // matchmaking signal alongside languages. Allowlist enforced in
    // PATCH /me so the queue can't be polluted with arbitrary strings.
    interests: { type: [String], default: undefined },

    // Auto-suspension: set when N distinct reporters flag this user inside
    // the suspension window (see routes/reports.js). Login + socket connect
    // refuse while this is in the future. Null/missing = not suspended.
    suspendedUntil: { type: Date },

    // Email verification status. Email signups start false (must click
    // the link). Google sign-ins start true (Google already verified the
    // address). Unverified users may use Bump until verificationDeadline,
    // after which isVerificationRequired() gates the core experience.
    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date },

    // Hard deadline by which an email signup must verify. Stamped at
    // registration to (createdAt + VERIFICATION_GRACE_MS). Null for Google
    // accounts (already verified) and any account created before this field
    // existed — a null deadline never triggers the gate.
    verificationDeadline: { type: Date },

    // Set whenever the password is changed (currently only via /reset).
    // verifyToken + socket auth reject JWTs whose `iat` is older than this
    // timestamp, so a password reset invalidates every existing session
    // for the user — important when reset is triggered because the account
    // was compromised.
    passwordChangedAt: { type: Date },

    // Single-device login: every fresh login/register/google-sign-in
    // rotates this value and embeds it in the JWT as `sid`. verifyToken +
    // socket auth reject any token whose `sid` doesn't match the current
    // value, so signing in on device B automatically invalidates the
    // token still cached on device A. Null on legacy accounts that
    // haven't logged in since the feature shipped — the middleware
    // treats "no active sid yet" as backward-compat and lets those
    // tokens keep working until their next login.
    activeSessionId: { type: String, default: null },
  },
  { timestamps: true }
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('passwordHash')) return next();
  this.passwordHash = await bcrypt.hash(this.passwordHash, 12);
  next();
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.passwordHash);
};

userSchema.methods.isSuspended = function () {
  return !!this.suspendedUntil && this.suspendedUntil > new Date();
};

// True once an unverified email account is past its grace deadline. A missing
// deadline (Google accounts, legacy rows) or a verified email both return false.
userSchema.methods.isVerificationRequired = function () {
  return (
    !this.emailVerified &&
    !!this.verificationDeadline &&
    this.verificationDeadline <= new Date()
  );
};

module.exports = mongoose.model('User', userSchema);
module.exports.USERNAME_REGEX = USERNAME_REGEX;
module.exports.VERIFICATION_GRACE_MS = VERIFICATION_GRACE_MS;
