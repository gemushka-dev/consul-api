import { Router } from 'express';
import { checkDbReady } from '../config/db.js';
import { checkRedisReady } from '../config/redis.js';

export const healthRouter = Router();

healthRouter.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

healthRouter.get('/readyz', async (_req, res) => {
  const [dbOk, redisOk] = await Promise.all([checkDbReady(), checkRedisReady()]);
  const ready = dbOk && redisOk;

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    checks: {
      postgres: dbOk ? 'ok' : 'error',
      redis: redisOk ? 'ok' : 'error',
    },
    timestamp: new Date().toISOString(),
  });
});
