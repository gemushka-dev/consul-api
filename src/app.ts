import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { docsRouter } from './docs/swagger.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { langMiddleware } from './middlewares/lang.js';
import { healthRouter } from './routes/health.js';
import { Errors } from './utils/errors.js';

export function createApp(): express.Express {
  const app = express();

  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: false, // allow Swagger UI assets on /api/docs
    }),
  );

  app.use(
    cors({
      origin: [env.FRONTEND_URL, 'http://localhost:3000', 'http://localhost:5173'],
      credentials: true,
    }),
  );

  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(langMiddleware);

  const apiV1 = express.Router();

  apiV1.get('/', (_req, res) => {
    res.json({
      name: 'Consul API',
      version: '2.0.0',
      env: env.APP_ENV,
    });
  });

  apiV1.use(healthRouter);

  app.use('/api/docs', docsRouter);
  app.use('/api/v1', apiV1);
  app.use(healthRouter);

  app.use((_req, _res, next) => {
    next(Errors.notFound('route_not_found', 'Endpoint not found'));
  });

  app.use(errorHandler);

  return app;
}

export const app = createApp();
