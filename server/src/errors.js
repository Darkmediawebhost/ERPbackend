export class HttpError extends Error {
  constructor(message, status = 400, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function notFound(message = 'Record not found') {
  throw new HttpError(message, 404);
}
