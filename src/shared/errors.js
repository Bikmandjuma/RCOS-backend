export class AppError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const badRequest = (m, details) => new AppError(400, m, "BAD_REQUEST", details);
export const unauthorized = (m = "Please sign in to continue.") => new AppError(401, m, "UNAUTHORIZED");
export const paymentRequired = (m) => new AppError(402, m, "SUBSCRIPTION_REQUIRED");
export const forbidden = (m = "Your role doesn't have permission to do this.") => new AppError(403, m, "FORBIDDEN");
export const notFound = (m = "Not found.") => new AppError(404, m, "NOT_FOUND");
export const conflict = (m) => new AppError(409, m, "CONFLICT");

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
