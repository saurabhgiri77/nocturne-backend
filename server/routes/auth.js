const router = require('express').Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const verifyToken = require('../middleware/verifyToken');

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });

// Public-shape serialization. Centralized so /register, /login, /google,
// /me, and PATCH /me always return the same fields.
const serializeUser = (user) => ({
  id: user._id,
  email: user.email,
  username: user.username || null,
  displayName: user.displayName || null,
  bio: user.bio || null,
  dateOfBirth: user.dateOfBirth || null,
});

// Minimum age to sign up. Mirror this in the frontend's constants/policy.js.
const MIN_AGE_YEARS = 18;

const ageInYears = (dob) => {
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age;
};

router.post('/register', async (req, res) => {
  try {
    const { email, password, username, dateOfBirth } = req.body;

    // Required fields
    if (!email || !password)
      return res.status(400).json({ message: 'Email and password required' });
    if (!username) return res.status(400).json({ message: 'Username required' });
    if (!dateOfBirth) return res.status(400).json({ message: 'Date of birth required' });
    if (password.length < 6)
      return res.status(400).json({ message: 'Min 6 chars' });

    // Username format
    const u = String(username).toLowerCase().trim();
    if (!User.USERNAME_REGEX.test(u)) {
      return res.status(400).json({
        message: 'Username must be 3–20 chars: lowercase letters, digits, _ or .',
      });
    }

    // DOB + age
    const dob = new Date(dateOfBirth);
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

    // Uniqueness checks
    if (await User.findOne({ email }))
      return res.status(409).json({ message: 'Email already registered' });
    if (await User.findOne({ username: u }))
      return res.status(409).json({ message: 'Username taken' });

    const user = new User({ email, passwordHash: password, username: u, dateOfBirth: dob });
    await user.save();

    res.status(201).json({
      token: signToken(user._id),
      user: serializeUser(user),
    });
  } catch (err) {
    if (err.code === 11000) {
      // Race condition between findOne and save — fallback duplicate-key handling
      return res.status(409).json({ message: 'Email or username already registered' });
    }
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ message: 'Email and password required' });

    const user = await User.findOne({ email });
    if (!user)
      return res.status(401).json({ message: 'Invalid credentials' });

    const ok = await user.comparePassword(password);
    if (!ok)
      return res.status(401).json({ message: 'Invalid credentials' });

    res.status(200).json({
      token: signToken(user._id),
      user: serializeUser(user),
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.post('/google', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken)
      return res.status(400).json({ message: 'Google access token required' });

    const googleRes = await fetch(
      `https://www.googleapis.com/oauth2/v3/userinfo`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!googleRes.ok)
      return res.status(401).json({ message: 'Invalid Google token' });

    const { sub: googleId, email } = await googleRes.json();

    let user = await User.findOne({ googleId });
    if (!user) {
      user = await User.findOne({ email });
      if (user) {
        user.googleId = googleId;
        await user.save();
      } else {
        user = await User.create({ email, googleId });
      }
    }

    res.status(200).json({
      token: signToken(user._id),
      user: serializeUser(user),
    });
  } catch (err) {
    res.status(401).json({ message: 'Google authentication failed', error: err.message });
  }
});

router.get('/me', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ user: serializeUser(user) });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.patch('/me', verifyToken, async (req, res) => {
  try {
    const { username, displayName, bio, dateOfBirth } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (username !== undefined) {
      const u = String(username).toLowerCase().trim();
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

    if (displayName !== undefined) {
      const d = String(displayName).trim();
      if (d.length > 50) return res.status(400).json({ message: 'Display name too long (max 50)' });
      user.displayName = d || undefined;
    }

    if (bio !== undefined) {
      const b = String(bio).trim();
      if (b.length > 200) return res.status(400).json({ message: 'Bio too long (max 200)' });
      user.bio = b || undefined;
    }

    if (dateOfBirth !== undefined) {
      const d = new Date(dateOfBirth);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ message: 'Invalid date of birth' });
      const age = ageInYears(d);
      if (age < MIN_AGE_YEARS) return res.status(400).json({ message: `Must be at least ${MIN_AGE_YEARS} years old` });
      if (age > 120) return res.status(400).json({ message: 'Invalid date of birth' });
      user.dateOfBirth = d;
    }

    await user.save();
    res.json({ user: serializeUser(user) });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Username taken' });
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
