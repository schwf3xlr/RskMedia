// Wraps an async route handler so a thrown/rejected error goes to Express's
// error middleware instead of leaving the request hanging. Without this,
// each controller has to duplicate a try/catch that only re-throws to next().
module.exports = function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
