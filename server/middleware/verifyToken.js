const jwt = require('jsonwebtoken');
const { isBlocked } = require('../lib/tokenBlocklist');

module.exports = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer '))
    return res.status(401).json({ message: 'No token provided' });
  const token = header.split(' ')[1];
  if (isBlocked(token)) {
    return res.status(401).json({ message: 'Token revoked' });
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    req.token = token; // exposed so /logout can blocklist it
    next();
  } catch {
    res.status(401).json({ message: 'Token invalid or expired' });
  }
};
