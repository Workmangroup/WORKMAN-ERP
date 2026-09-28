import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { env } from '../config/env.js';
import { ALLOWED_UPLOADS } from '../config/constants.js';
import { badRequest } from '../utils/httpError.js';

fs.mkdirSync(env.uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: env.uploadDir,
  // Nom aléatoire : jamais de nom fourni par l'utilisateur sur le disque
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
});

function fileFilter(_req, file, cb) {
  const allowedExt = ALLOWED_UPLOADS[file.mimetype];
  const ext = path.extname(file.originalname).toLowerCase();
  if (!allowedExt || !allowedExt.includes(ext)) {
    return cb(badRequest('Type de fichier non autorisé (PDF, JPG, PNG, DOC, DOCX uniquement)'));
  }
  cb(null, true);
}

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: env.maxUploadBytes, files: 1, fields: 20 },
});

/** Supprime un fichier uploadé (ex. si la transaction échoue). */
export function removeUploaded(file) {
  if (file?.path) fs.promises.unlink(file.path).catch(() => {});
}

/**
 * Uploader à extensions restreintes, indépendant de `upload` ci-dessus (qui reste
 * inchangé pour les demandes RH). Utilisé par les modules Congés et Retards, dont
 * les formats acceptés diffèrent (pas de .doc pour les congés, .zip pour les retards).
 */
export function createScopedUpload(allowedExtensions, label) {
  const scopedFilter = (_req, file, cb) => {
    const allowedExt = ALLOWED_UPLOADS[file.mimetype];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedExt || !allowedExt.includes(ext) || !allowedExtensions.includes(ext)) {
      return cb(badRequest(`Type de fichier non autorisé (${label} uniquement)`));
    }
    cb(null, true);
  };
  return multer({ storage, fileFilter: scopedFilter, limits: { fileSize: env.maxUploadBytes, files: 1, fields: 20 } });
}
