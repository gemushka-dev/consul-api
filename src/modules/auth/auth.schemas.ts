import { z } from 'zod';

const phoneRegex = /^\+?[0-9]{9,15}$/;

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('998')) return `+${digits}`;
  return `+${digits}`;
}

export const otpSendSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(phoneRegex, 'Invalid phone number format')
    .transform(normalizePhone),
});

export const otpVerifySchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(phoneRegex, 'Invalid phone number format')
    .transform(normalizePhone),
  code: z.string().trim().regex(/^\d{6}$/, 'OTP code must be 6 digits'),
});

export const registerSchema = z.object({
  email: z.string().trim().email('Invalid email address').toLowerCase(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  lang: z.enum(['uz', 'ru', 'en']).default('uz'),
});

export const loginSchema = z.object({
  email: z.string().trim().email('Invalid email address').toLowerCase(),
  password: z.string().min(1, 'Password is required'),
});
