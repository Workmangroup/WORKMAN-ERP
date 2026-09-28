import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import { pool } from './config/db.js';
import { csrfProtection } from './middlewares/csrf.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';
import { apiLimiter } from './middlewares/rateLimit.js';
import authRoutes from './modules/auth/auth.routes.js';
import meRoutes from './modules/me/me.routes.js';
import demandesRoutes from './modules/demandes/demandes.routes.js';
import reclamationsRoutes from './modules/reclamations/reclamations.routes.js';
import suggestionsRoutes from './modules/suggestions/suggestions.routes.js';
import rhRoutes from './modules/rh/rh.routes.js';
import directionRoutes from './modules/direction/direction.routes.js';
import notificationsRoutes from './modules/notifications/notifications.routes.js';
import questionnaireRoutes from './modules/questionnaire/questionnaire.routes.js';
import collaborateursRoutes from './modules/collaborateurs/collaborateurs.routes.js';
import congesRoutes from './modules/conges/conges.routes.js';
import sortiesRoutes from './modules/sorties/sorties.routes.js';
import retardsRoutes from './modules/retards/retards.routes.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  if (env.isProd) app.set('trust proxy', 1); // derrière un reverse proxy (IP réelle pour logs et rate-limit)

  app.use(helmet());
  app.use(cors({ origin: env.frontendUrl, credentials: true, allowedHeaders: ['Content-Type', 'X-CSRF-Token'] }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(morgan(env.isProd ? 'combined' : 'dev'));

  app.use('/api', apiLimiter);

  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', database: 'up' });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'down' });
    }
  });

  // Toute requête modifiante doit porter un jeton CSRF valide
  app.use('/api', csrfProtection);

  app.use('/api/auth', authRoutes);
  app.use('/api/me', meRoutes);
  app.use('/api/demandes', demandesRoutes);
  app.use('/api/reclamations', reclamationsRoutes);
  app.use('/api/suggestions', suggestionsRoutes);
  app.use('/api/rh/collaborateurs', collaborateursRoutes);
  app.use('/api/rh', rhRoutes);
  app.use('/api/direction', directionRoutes);
  app.use('/api/notifications', notificationsRoutes);
  app.use('/api/questionnaire', questionnaireRoutes);
  // Chemins internes complets (/conges, /me/conges, /rh/conges, …) : montés à la racine /api
  app.use('/api', congesRoutes);
  app.use('/api', sortiesRoutes);
  app.use('/api', retardsRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
