import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { validateBody } from '../../middlewares/validate.js';
import { clearAuthCookies } from '../auth/auth.service.js';
import { exportUserOpsCsv } from '../reports/reports.service.js';
import { consentSchema, patchMeSchema, putBusinessSchema } from './user.schemas.js';
import {
  deleteUserAccount,
  getUserProfile,
  setPersonalDataConsent,
  setStatsConsent,
  updateUserProfile,
  upsertBusinessProfile,
} from './user.service.js';

export const userRouter = Router();

userRouter.use(requireAuth);

userRouter.get('/', async (req, res, next) => {
  try {
    const profile = await getUserProfile(req.user!.id);
    res.json(profile);
  } catch (err) {
    next(err);
  }
});

userRouter.patch('/', validateBody(patchMeSchema), async (req, res, next) => {
  try {
    const profile = await updateUserProfile(req.user!.id, req.body);
    res.json(profile);
  } catch (err) {
    next(err);
  }
});

userRouter.put('/business', validateBody(putBusinessSchema), async (req, res, next) => {
  try {
    const business = await upsertBusinessProfile(req.user!.id, req.body);
    res.json({ business });
  } catch (err) {
    next(err);
  }
});

userRouter.post('/consent', async (req, res, next) => {
  try {
    const parsed = consentSchema.parse(req.body);
    const user = await setPersonalDataConsent(req.user!.id, true, parsed.version);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

userRouter.delete('/consent', async (req, res, next) => {
  try {
    const user = await setPersonalDataConsent(req.user!.id, false);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

userRouter.post('/consent/stats', async (req, res, next) => {
  try {
    const user = await setStatsConsent(req.user!.id, true);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

userRouter.delete('/consent/stats', async (req, res, next) => {
  try {
    const user = await setStatsConsent(req.user!.id, false);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

userRouter.get('/export.csv', async (req, res, next) => {
  try {
    const csv = await exportUserOpsCsv(req.user!.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="consul-my-operations.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

userRouter.delete('/', async (req, res, next) => {
  try {
    await deleteUserAccount(req.user!.id);
    clearAuthCookies(res);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
