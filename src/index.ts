import { app } from './app.js';
import { env } from './config/env.js';

// Default export required by Vercel zero-config Express runtime
export default app;

// Only bind a TCP port when running outside Vercel Serverless
if (!process.env.VERCEL) {
  const server = app.listen(env.PORT, () => {
    console.log(`[consul-api] listening on http://localhost:${env.PORT} (env=${env.APP_ENV})`);
  });

  const shutdown = (signal: string) => {
    console.log(`[consul-api] received ${signal}, shutting down...`);
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
