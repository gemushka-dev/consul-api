import { z } from 'zod';

export const patchMeSchema = z.object({
  lang: z.enum(['uz', 'ru', 'en']).optional(),
  prefs: z
    .object({
      largeFont: z.boolean().optional(),
      voiceReply: z.boolean().optional(),
      voiceSpeed: z.number().min(0.5).max(2.0).optional(),
    })
    .optional(),
});

export const putBusinessSchema = z.object({
  trade: z.string().trim().min(1, 'Trade description is required').max(200),
  sector: z.enum(['dried_fruit', 'food', 'clothes', 'services', 'other']),
  market: z.enum(['chorsu', 'oloy', 'parkent', 'quyliq', 'other']),
  status: z.enum(['yatt', 'oob', 'mchj', 'none']),
  regime: z.enum(['turnover', 'vat6', 'vat12']),
  reserve: z.number().int().min(0, 'Reserve must be non-negative').default(0),
});

export const consentSchema = z
  .object({
    version: z.string().trim().min(1).max(20).default('2026-v1'),
  })
  .optional()
  .default({ version: '2026-v1' });
