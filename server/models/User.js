const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const USERNAME_REGEX = /^[a-z0-9_.]{3,20}$/;

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

    // Auto-suspension: set when N distinct reporters flag this user inside
    // the suspension window (see routes/reports.js). Login + socket connect
    // refuse while this is in the future. Null/missing = not suspended.
    suspendedUntil: { type: Date },
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

module.exports = mongoose.model('User', userSchema);
module.exports.USERNAME_REGEX = USERNAME_REGEX;
