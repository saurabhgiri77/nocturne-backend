const router = require('express').Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });

router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ message: 'Email and password required' });
    if (password.length < 6)
      return res.status(400).json({ message: 'Min 6 chars' });

    if (await User.findOne({ email }))
      return res.status(409).json({ message: 'Email already registered' });

    const user = new User({ email, passwordHash: password });
    await user.save();

    res.status(201).json({
      token: signToken(user._id),
      user: { id: user._id, email: user.email },
    });
  } catch (err) {
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
      user: { id: user._id, email: user.email },
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
