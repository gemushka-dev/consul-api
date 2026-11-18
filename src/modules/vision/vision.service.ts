import OpenAI from 'openai';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { OpLineItem } from '../../db/schema.js';
import type { SupportedLang } from '../../types/express.d.js';
import { Errors } from '../../utils/errors.js';

export interface VisionDraftOp {
  kind: 'sale' | 'buy' | 'exp' | 'sup';
  amount: number;
  method: 'naqd' | 'karta';
  label: string;
  fiscal: boolean;
  source: 'photo';
  items: OpLineItem[];
  confidence: number;
}

export interface PhotoRecognitionResult {
  document_type: 'receipt' | 'invoice' | 'transfer' | 'unknown';
  summary: string;
  draft_ops: VisionDraftOp[];
  provider: 'vision-llm' | 'demo-stub';
}

const llmDraftSchema = z.object({
  document_type: z.enum(['receipt', 'invoice', 'transfer', 'unknown']).default('receipt'),
  summary: z.string().default(''),
  draft_ops: z
    .array(
      z.object({
        kind: z.enum(['sale', 'buy', 'exp', 'sup']).default('buy'),
        amount: z.number().int().positive(),
        method: z.enum(['naqd', 'karta']).default('naqd'),
        label: z.string().min(1).max(200),
        fiscal: z.boolean().default(false),
        items: z
          .array(
            z.object({
              name: z.string().min(1),
              qty: z.number().optional(),
              unit: z.string().optional(),
              price: z.number().int().optional(),
              total: z.number().int(),
            }),
          )
          .default([]),
        confidence: z.number().min(0).max(1).default(0.8),
      }),
    )
    .default([]),
});

export async function recognizeDocumentPhoto(params: {
  buffer: Buffer;
  mimetype: string;
  lang: SupportedLang;
}): Promise<PhotoRecognitionResult> {
  if (!env.AI_API_KEY) {
    if (env.APP_ENV === 'demo') {
      return {
        document_type: 'invoice',
        summary:
          params.lang === 'ru'
            ? 'Накладная поставщика: сухофрукты на 1 850 000 сум'
            : "Ta'minotchi yuk xati: quritilgan mevalar 1 850 000 so'm",
        draft_ops: [
          {
            kind: 'buy',
            amount: 1_850_000,
            method: 'naqd',
            label:
              params.lang === 'ru'
                ? 'Закупка сухофруктов по накладной'
                : 'Yuk xati bo‘yicha quritilgan mevalar xaridi',
            fiscal: true,
            source: 'photo',
            items: [
              { name: 'Mayiz (qora)', qty: 20, unit: 'kg', price: 45_000, total: 900_000 },
              { name: 'Bodom', qty: 10, unit: 'kg', price: 95_000, total: 950_000 },
            ],
            confidence: 0.92,
          },
        ],
        provider: 'demo-stub',
      };
    }

    throw Errors.serviceUnavailable('vision_not_configured', 'Vision AI API key is not configured');
  }

  const client = new OpenAI({
    apiKey: env.AI_API_KEY,
    baseURL: env.AI_BASE_URL,
    timeout: 15_000,
  });

  const dataUri = `data:${params.mimetype};base64,${params.buffer.toString('base64')}`;

  const completion = await client.chat.completions.create({
    model: env.AI_VISION_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are a receipt/invoice OCR parser for Uzbekistan small businesses.
Extract structured financial operation drafts strictly as JSON:
{
  "document_type": "receipt" | "invoice" | "transfer" | "unknown",
  "summary": "short description in ${params.lang}",
  "draft_ops": [
    {
      "kind": "sale" | "buy" | "exp" | "sup",
      "amount": integer_UZS,
      "method": "naqd" | "karta",
      "label": "short label",
      "fiscal": boolean,
      "items": [{"name": "...", "qty": 1, "unit": "kg", "price": 10000, "total": 10000}],
      "confidence": 0.0..1.0
    }
  ]
}
All amounts must be integer UZS. Never invent items not visible on the image.`,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Parse this receipt/invoice into draft_ops[] (language: ${params.lang}).` },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  let parsedJson: unknown = {};
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    parsedJson = {};
  }

  const validated = llmDraftSchema.safeParse(parsedJson);
  if (!validated.success) {
    return {
      document_type: 'unknown',
      summary: params.lang === 'ru' ? 'Не удалось распознать документ' : 'Hujjatni aniqlab bo‘lmadi',
      draft_ops: [],
      provider: 'vision-llm',
    };
  }

  return {
    document_type: validated.data.document_type,
    summary: validated.data.summary,
    draft_ops: validated.data.draft_ops.map((d) => ({
      ...d,
      source: 'photo',
    })),
    provider: 'vision-llm',
  };
}
