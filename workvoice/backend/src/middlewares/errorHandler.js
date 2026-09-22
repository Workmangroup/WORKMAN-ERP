import multer from 'multer';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { HttpError } from '../utils/httpError.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route introuvable : ${req.method} ${req.path}` } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Certains champs sont invalides',
        details: err.issues.map((i) => ({ champ: i.path.join('.'), message: i.message })),
      },
    });
  }

  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `Fichier trop volumineux (max ${Math.round(env.maxUploadBytes / 1024 / 1024)} Mo)`
      : 'Fichier invalide';
    return res.status(400).json({ error: { code: 'UPLOAD_ERROR', message } });
  }

  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }

  // JSON malformé
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Corps de requête JSON invalide' } });
  }

  console.error('[error]', req.method, req.originalUrl, err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Une erreur interne est survenue',
      ...(env.isProd ? {} : { debug: err.message }),
    },
  });
}
