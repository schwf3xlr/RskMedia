// Typed error for API responses. Controllers throw ApiError(status, msg, code)
// and the central error middleware in app.js turns it into a JSON response
// with the right HTTP status. Anything that isn't an ApiError is treated as
// a 500 (bug) and only leaks its message in non-prod.
class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || null;
    this.name = 'ApiError';
    // Non-enumerable so JSON.stringify(err) doesn't dump internal state
    // if some careless caller passes the error object into a response.
    Object.defineProperty(this, 'isApiError', { value: true });
  }
  static badRequest(msg, code) { return new ApiError(400, msg, code); }
  static unauthorized(msg, code) { return new ApiError(401, msg, code); }
  static forbidden(msg, code) { return new ApiError(403, msg, code); }
  static notFound(msg, code) { return new ApiError(404, msg, code); }
  static conflict(msg, code) { return new ApiError(409, msg, code); }
  static tooLarge(msg, code) { return new ApiError(413, msg, code); }
  static internal(msg, code) { return new ApiError(500, msg, code); }
}

module.exports = ApiError;
