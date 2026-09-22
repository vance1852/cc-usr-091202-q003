export class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const notFound = (what) => new AppError("NOT_FOUND", `${what}不存在`, 404);
export const badRequest = (code, message, details) => new AppError(code, message, 400, details);
export const conflict = (code, message, details) => new AppError(code, message, 409, details);
