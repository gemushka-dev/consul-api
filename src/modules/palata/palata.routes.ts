import { Router } from 'express';
import { z } from 'zod';
import { optionalAuth, requireAuth } from '../../middlewares/auth.js';
import { validateBody } from '../../middlewares/validate.js';
import {
  exportPalataReportCsv,
  getPalataReport,
  recordSurveyAnswer,
} from './palata.service.js';

const surveySchema = z.object({
  question: z.string().trim().min(1).max(100).default('why_not_registered'),
  answer: z.string().trim().min(1, 'Answer is required').max(100),
});

function parseWindowParam(raw: unknown): 30 | 90 {
  return Number(raw) === 90 ? 90 : 30;
}

export const palataRouter = Router();

palataRouter.get('/report', optionalAuth, async (req, res, next) => {
  try {
    const windowDays = parseWindowParam(req.query.window);
    const report = await getPalataReport(windowDays);
    res.json(report);
  } catch (err) {
    next(err);
  }
});

palataRouter.get('/report.csv', optionalAuth, async (req, res, next) => {
  try {
    const windowDays = parseWindowParam(req.query.window);
    const csv = await exportPalataReportCsv(windowDays);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="consul-palata-report-${windowDays}d.csv"`,
    );
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

palataRouter.post('/survey', requireAuth, validateBody(surveySchema), async (req, res, next) => {
  try {
    const saved = await recordSurveyAnswer(req.user!.id, req.body.question, req.body.answer);
    res.status(201).json({ survey: saved });
  } catch (err) {
    next(err);
  }
});
