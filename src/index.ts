import { app } from './app.js';
import { env } from './config/env.js';

const server = app.listen(env.PORT, () => {
  console.log(`[consul-api] listening on http://localhost:${env.PORT} (env=${env.APP_ENV})`);
});

function shutdown(signal: string) {
  console.log(`[consul-api] received ${signal}, shutting down...`);
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
