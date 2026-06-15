function requireAdmin(req, res, next) {
  if (!req.user || req.user.type !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { requireAdmin };
