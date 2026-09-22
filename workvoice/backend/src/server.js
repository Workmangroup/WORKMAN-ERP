import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePools } from './config/db.js';

const app = createApp();

const server = app.listen(env.port, () => {
  console.info(`WORKVOICE API démarrée sur http://localhost:${env.port} (${env.nodeEnv})`);
});

async function shutdown(signal) {
  console.info(`${signal} reçu, arrêt en cours…`);
  server.close(async () => {
    await closePools().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
