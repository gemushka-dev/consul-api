import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmetModule, { type HelmetOptions } from 'helmet';

type HelmetFn = (options?: Readonly<HelmetOptions>) => express.RequestHandler;
const helmet: HelmetFn =
  typeof helmetModule === 'function'
    ? (helmetModule as unknown as HelmetFn)
    : (helmetModule as unknown as { default: HelmetFn }).default;
import { env } from './config/env.js';
import { docsRouter } from './docs/swagger.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { langMiddleware } from './middlewares/lang.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { calculatorRouter } from './modules/calculators/calculators.routes.js';
import { chatsRouter, consulRouter, memoryRouter } from './modules/consul/consul.routes.js';
import {
  debtorsRouter,
  ledgerRouter,
  obligationsRouter,
} from './modules/ledger/ledger.routes.js';
import { opsRouter } from './modules/ledger/ops.routes.js';
import { palataRouter } from './modules/palata/palata.routes.js';
import {
  advisorRouter,
  forecastRouter,
  reportsRouter,
} from './modules/reports/reports.routes.js';
import { userRouter } from './modules/user/user.routes.js';
import { visionRouter } from './modules/vision/vision.routes.js';
import { voiceRouter } from './modules/voice/voice.routes.js';
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

  const allowedOrigins = [
    env.FRONTEND_URL,
    'http://localhost:3000',
    'http://localhost:5173',
    ...(process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : []),
  ];

  app.use(
    cors({
      origin: allowedOrigins,
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
  apiV1.use('/auth', authRouter);
  apiV1.use('/me', userRouter);
  apiV1.use('/ledger', ledgerRouter);
  apiV1.use('/ops', opsRouter);
  apiV1.use('/debtors', debtorsRouter);
  apiV1.use('/obligations', obligationsRouter);
  apiV1.use('/calculator', calculatorRouter);
  apiV1.use('/consul', consulRouter);
  apiV1.use('/voice', voiceRouter);
  apiV1.use('/photo', visionRouter);
  apiV1.use('/palata', palataRouter);
  apiV1.use('/reports', reportsRouter);
  apiV1.use('/forecast', forecastRouter);
  apiV1.use('/advisor', advisorRouter);
  apiV1.use('/chats', chatsRouter);
  apiV1.use('/memory', memoryRouter);

  app.get('/', (_req, res) => {
    res.json({
      name: 'Consul API',
      version: '2.0.0',
      docs: '/api/docs',
      health: '/api/v1/healthz',
      ready: '/api/v1/readyz',
    });
  });

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
