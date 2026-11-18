import { Router } from 'express';
import { validateBody } from '../../middlewares/validate.js';
import { Errors } from '../../utils/errors.js';
import {
  loginSchema,
  otpSendSchema,
  otpVerifySchema,
  registerSchema,
} from './auth.schemas.js';
import {
  blacklistRefreshToken,
  clearAuthCookies,
  issueAuthTokens,
  loginLegacy,
  registerLegacy,
  rotateRefreshToken,
  sendOtp,
  serializeUser,
  setAuthCookies,
  verifyOtp,
} from './auth.service.js';

export const authRouter = Router();

authRouter.post('/otp/send', validateBody(otpSendSchema), async (req, res, next) => {
  try {
    const clientIp = req.ip || 'unknown';
    await sendOtp(req.body.phone, clientIp);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

authRouter.post('/otp/verify', validateBody(otpVerifySchema), async (req, res, next) => {
  try {
    const { user, isNew } = await verifyOtp(req.body.phone, req.body.code);
    const { accessToken, refreshToken } = issueAuthTokens(user);
    setAuthCookies(res, accessToken, refreshToken);
    res.json({
      user: serializeUser(user),
      is_new: isNew,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/register', validateBody(registerSchema), async (req, res, next) => {
  try {
    const user = await registerLegacy(req.body.email, req.body.password, req.body.lang);
    const { accessToken, refreshToken } = issueAuthTokens(user);
    setAuthCookies(res, accessToken, refreshToken);
    res.status(201).json({
      user: serializeUser(user),
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', validateBody(loginSchema), async (req, res, next) => {
  try {
    const user = await loginLegacy(req.body.email, req.body.password);
    const { accessToken, refreshToken } = issueAuthTokens(user);
    setAuthCookies(res, accessToken, refreshToken);
    res.json({
      user: serializeUser(user),
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const token =
      (typeof req.cookies?.refresh_token === 'string' && req.cookies.refresh_token) ||
      (typeof req.body?.refresh_token === 'string' && req.body.refresh_token) ||
      '';
    if (!token) {
      throw Errors.unauthorized('missing_refresh_token', 'Refresh token cookie is required');
    }

    const user = await rotateRefreshToken(token);
    const { accessToken, refreshToken } = issueAuthTokens(user);
    setAuthCookies(res, accessToken, refreshToken);
    res.json({
      user: serializeUser(user),
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    const token = req.cookies?.refresh_token;
    if (typeof token === 'string' && token.length > 0) {
      await blacklistRefreshToken(token);
    }
    clearAuthCookies(res);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
