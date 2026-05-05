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

module.exports = mongoose.model('User', userSchema);
module.exports.USERNAME_REGEX = USERNAME_REGEX;
