function requireAdmin(req, res, next) {
  if (!req.user || req.user.type !== 'admin') {
    if (req.accepts('html')) {
      return res.status(403).redirect('/');
    }
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { requireAdmin };
