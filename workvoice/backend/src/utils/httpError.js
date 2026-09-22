export class HttpError extends Error {
  constructor(status, message, code = 'ERROR', details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, 'BAD_REQUEST', details);
export const unauthorized = (msg = 'Authentification requise') => new HttpError(401, msg, 'UNAUTHORIZED');
export const forbidden = (msg = 'Accès refusé') => new HttpError(403, msg, 'FORBIDDEN');
export const notFound = (msg = 'Ressource introuvable') => new HttpError(404, msg, 'NOT_FOUND');
export const conflict = (msg) => new HttpError(409, msg, 'CONFLICT');
