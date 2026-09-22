import 'dotenv/config';
import path from 'node:path';

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';

function required(key) {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(`Variable d'environnement manquante : ${key}`);
  }
  return value;
}

const jwtSecret = required('JWT_SECRET');
if (isProd && jwtSecret.length < 32) {
  throw new Error('JWT_SECRET doit contenir au moins 32 caractères en production');
}

export const env = {
  nodeEnv,
  isProd,
  port: Number(process.env.PORT || 4000),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || 'workvoice',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  },
  dbDirection: {
    user: process.env.DB_DIRECTION_USER || '',
    password: process.env.DB_DIRECTION_PASSWORD || '',
  },

  jwt: {
    secret: jwtSecret,
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    issuer: 'workvoice',
  },

  uploadDir: path.resolve(process.env.UPLOAD_DIR || './uploads'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 5) * 1024 * 1024,

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || 'WORKVOICE <workvoice@workman.tn>',
  },
};
