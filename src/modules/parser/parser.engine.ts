import OpenAI from 'openai';
import { env } from '../../config/env.js';

export type ParsedIntentType =
  | 'op'
  | 'fix'
  | 'rent'
  | 'question'
  | 'report'
  | 'need-amount'
  | 'need-kind'
  | 'unknown';

export type OpKind = 'sale' | 'buy' | 'exp' | 'sup' | 'nas' | 'repaid' | 'fix' | 'opening';
export type PayMethod = 'naqd' | 'karta' | 'none';

export interface ParsedOperationDraft {
  kind: OpKind;
  amount: number;
  method: PayMethod;
  label?: string;
  counterparty_name?: string;
  fiscal?: boolean;
}

export interface ParseResult {
  intent: ParsedIntentType;
  draft: ParsedOperationDraft | null;
  confirm: boolean;
  confirm_reason?: string;
  source: 'deterministic' | 'llm';
  raw_text: string;
}

const CONFIRM_THRESHOLD = 1_000_000_000;

/**
 * Extracts monetary amount in UZS from UZ/RU text.
 * Supports: "1,2 mln", "1.5 млрд", "500 ming", "300 тыс", "250k", "1 200 000", "450000".
 */
export function extractAmountUzs(text: string): number | null {
  const lower = text.toLowerCase().replace(/\u00a0/g, ' ');

  // 1. Number with explicit multiplier (mlrd / mln / ming / k)
  const multRegex =
    /(\d+(?:[.,]\d+)?)\s*(mlrd|milliard|млрд|миллиард(?:ов|а)?|mln|million|млн|миллион(?:ов|а)?|ming|тыс\.?|тысяч(?:и|а)?|[kк])(?![a-zа-яё])/i;
  const multMatch = lower.match(multRegex);
  if (multMatch && multMatch[1] && multMatch[2]) {
    const num = Number(multMatch[1].replace(',', '.'));
    const unit = multMatch[2].toLowerCase();
    if (Number.isFinite(num) && num > 0) {
      if (unit.startsWith('mlrd') || unit.startsWith('millia') || unit.startsWith('млрд') || unit.startsWith('миллиард')) {
        return Math.round(num * 1_000_000_000);
      }
      if (unit.startsWith('mln') || unit.startsWith('millio') || unit.startsWith('млн') || unit.startsWith('миллион')) {
        return Math.round(num * 1_000_000);
      }
      return Math.round(num * 1_000);
    }
  }

  // 2. Spaced thousands like "1 200 000" or "500 000"
  const spacedRegex = /\b(\d{1,3}(?:[ \t]\d{3})+)\b/;
  const spacedMatch = lower.match(spacedRegex);
  if (spacedMatch && spacedMatch[1]) {
    const val = Number(spacedMatch[1].replace(/\s+/g, ''));
    if (Number.isFinite(val) && val > 0) return Math.round(val);
  }

  // 3. Plain integer >= 100 (avoid treating dates/quantities like "2" as UZS unless >= 100)
  const plainRegex = /\b(\d{3,15})\b/;
  const plainMatch = lower.match(plainRegex);
  if (plainMatch && plainMatch[1]) {
    const val = Number(plainMatch[1]);
    if (Number.isFinite(val) && val > 0) return Math.round(val);
  }

  return null;
}

export function detectPaymentMethod(text: string, kind?: OpKind): PayMethod {
  if (kind === 'nas') return 'none';
  const lower = text.toLowerCase();
  if (
    /(karta|kartaga|kartadan|click|payme|uzcard|humo|terminal|карт(?:а|е|у|ы|ой|очк)|перевод|безнал|терминал)/i.test(
      lower,
    )
  ) {
    return 'karta';
  }
  if (/(naqd|naqt|налич|налом|кэш|кеш|cash)/i.test(lower)) {
    return 'naqd';
  }
  return 'naqd';
}

export function detectFiscal(text: string): boolean {
  return /(chek|чек|qr|кюар|terminal|терминал|fiskal|фискал|click|payme|uzcard|humo)/i.test(text);
}

/**
 * Extracts debtor/counterparty name for nasiya/repaid phrases like:
 * "Akmalga 400 ming nasiya", "Алишеру в долг 300 тыс", "nasiya Olim 500 ming".
 */
export function extractCounterpartyName(text: string): string | undefined {
  // Uzbek dative "-ga" / "-ka" / "-qa" on capitalized or first word before amount/nasiya
  const uzDative = text.match(/\b([A-ZА-ЯЁ][a-zа-яё'ʼ`-]{2,20})(?:ga|ka|qa)\b/);
  if (uzDative && uzDative[1]) {
    const candidate = uzDative[1];
    if (!/^(Bugun|Kecha|Ertaga|Karta|Naqd|Bozor|Do'kon|Kassa)$/i.test(candidate)) {
      return candidate;
    }
  }

  // Russian dative/preposition patterns: "Алишеру в долг", "от Акмала", "клиенту Рустаму"
  const ruPattern = text.match(
    /(?:клиенту|от|для|должник[уа]?)\s+([А-ЯЁA-Z][а-яёa-z'-]{2,20})/i,
  );
  if (ruPattern && ruPattern[1]) {
    return ruPattern[1];
  }

  // Capitalized proper noun that is not a common stop word
  const words = text.match(/\b[A-ZА-ЯЁ][a-zа-яё'ʼ`-]{2,20}\b/g) ?? [];
  const stop = new Set([
    'Bugun',
    'Kecha',
    'Ertaga',
    'Nasiya',
    'Qarz',
    'Karta',
    'Naqd',
    'Сегодня',
    'Вчера',
    'Насия',
    'Долг',
    'Карта',
    'Наличные',
    'Аренда',
    'Кредит',
    'Отчёт',
    'Отчет',
  ]);
  for (const w of words) {
    if (!stop.has(w)) {
      // Strip common RU/UZ dative endings if obvious
      if (w.endsWith('ga') && w.length > 4) return w.slice(0, -2);
      if (w.endsWith('у') && w.length > 4) return w.slice(0, -1);
      return w;
    }
  }
  return undefined;
}

const QUESTION_PATTERNS = [
  /\?\s*$/,
  /^(qancha|qanday|qachon|mumkinmi|olsa\s+bo['’`]?ladimi|necha|kim\s+qarzdor|nimaga)/i,
  /^(сколько|можно\s+ли|как\s+|стоит\s+ли|хватит\s+ли|какой\s+налог|потяну\s+ли)/i,
  /(kredit\s+olsam|кредит\s+взять|потяну\s+ли\s+кредит|soliq\s+qancha|какой\s+налог)/i,
];

const REPORT_PATTERNS = [
  /\b(hisobot|otchet|отч[её]т|statistika|сводка|bank\s+uchun|для\s+банка|oylik\s+yakun)\b/i,
];

const FIX_PATTERNS = [
  /\b(kassada|qoldiq|balans|sverka|в\s+кассе|остаток|баланс|сверка)\b/i,
];

const RENT_PATTERNS = [/\b(ijara|arenda|аренд[ауеы]|joy\s+puli)\b/i];

const KIND_MATCHERS: Array<{ kind: OpKind; regex: RegExp }> = [
  {
    kind: 'repaid',
    regex:
      /(qarz(?:ni|ini)?\s*(?:qaytardi|to['’`]?ladi|berdi)|nasiya(?:ni)?\s*(?:qaytardi|to['’`]?ladi)|вернул(?:а|и)?\s*долг|погасил(?:а|и)?|отдал(?:а|и)?\s*долг|возврат\s*долга)/i,
  },
  {
    kind: 'nas',
    regex: /(nasiya|qarzga|qarz\s+berdim|в\s+долг|наси[яю]|дал\s+в\s+долг|долг\s+берд)/i,
  },
  {
    kind: 'sup',
    regex: /(ta['’`]?minotchi|postavshik|поставщик|yuk\s+puli|оплата\s+поставщик)/i,
  },
  {
    kind: 'buy',
    regex:
      /(sotib\s+oldim|oldim|xarid|tovar\s+oldim|закуп(?:ил|ка|или)|купил(?:а|и)?|приход\s+товара)/i,
  },
  {
    kind: 'exp',
    regex:
      /(xarajat|rasxod|расход|потратил(?:а|и)?|to['’`]?ladim|оплатил(?:а|и)?|yo['’`]?lkira|доставка|транспорт|свет|elektr|kommunal|коммунал|maosh|зарплат)/i,
  },
  {
    kind: 'sale',
    regex: /(sotdim|savdo|tushum|sotuv|продал(?:а|и)?|выручк[аи]|продаж[аи]|касс[аеу])/i,
  },
];

export function parseOperationDeterministic(rawText: string): ParseResult {
  const text = rawText.trim();
  if (!text) {
    return {
      intent: 'unknown',
      draft: null,
      confirm: false,
      source: 'deterministic',
      raw_text: rawText,
    };
  }

  // 1. Reports
  if (REPORT_PATTERNS.some((re) => re.test(text))) {
    return {
      intent: 'report',
      draft: null,
      confirm: false,
      source: 'deterministic',
      raw_text: rawText,
    };
  }

  // 2. Questions (advisory / analytics / loan / tax)
  if (QUESTION_PATTERNS.some((re) => re.test(text))) {
    return {
      intent: 'question',
      draft: null,
      confirm: false,
      source: 'deterministic',
      raw_text: rawText,
    };
  }

  const amount = extractAmountUzs(text);

  // 3. Cash reconciliation / fix
  if (FIX_PATTERNS.some((re) => re.test(text))) {
    if (amount === null) {
      return {
        intent: 'need-amount',
        draft: null,
        confirm: false,
        source: 'deterministic',
        raw_text: rawText,
      };
    }
    const method = detectPaymentMethod(text, 'fix');
    return {
      intent: 'fix',
      draft: {
        kind: 'fix',
        amount,
        method,
        label: text.slice(0, 120),
      },
      confirm: amount >= CONFIRM_THRESHOLD,
      ...(amount >= CONFIRM_THRESHOLD ? { confirm_reason: 'large_amount' } : {}),
      source: 'deterministic',
      raw_text: rawText,
    };
  }

  // 4. Rent payment
  if (RENT_PATTERNS.some((re) => re.test(text))) {
    if (amount === null) {
      return {
        intent: 'need-amount',
        draft: null,
        confirm: false,
        source: 'deterministic',
        raw_text: rawText,
      };
    }
    const method = detectPaymentMethod(text, 'exp');
    return {
      intent: 'rent',
      draft: {
        kind: 'exp',
        amount,
        method,
        label: text.slice(0, 120),
        fiscal: detectFiscal(text),
      },
      confirm: amount >= CONFIRM_THRESHOLD,
      ...(amount >= CONFIRM_THRESHOLD ? { confirm_reason: 'large_amount' } : {}),
      source: 'deterministic',
      raw_text: rawText,
    };
  }

  // 5. Standard operation kinds
  let detectedKind: OpKind | null = null;
  for (const matcher of KIND_MATCHERS) {
    if (matcher.regex.test(text)) {
      detectedKind = matcher.kind;
      break;
    }
  }

  if (detectedKind && amount === null) {
    return {
      intent: 'need-amount',
      draft: null,
      confirm: false,
      source: 'deterministic',
      raw_text: rawText,
    };
  }

  if (!detectedKind && amount !== null) {
    return {
      intent: 'need-kind',
      draft: null,
      confirm: amount >= CONFIRM_THRESHOLD,
      ...(amount >= CONFIRM_THRESHOLD ? { confirm_reason: 'large_amount' } : {}),
      source: 'deterministic',
      raw_text: rawText,
    };
  }

  if (detectedKind && amount !== null) {
    const method = detectPaymentMethod(text, detectedKind);
    const counterpartyName =
      detectedKind === 'nas' || detectedKind === 'repaid' || detectedKind === 'sup'
        ? extractCounterpartyName(text)
        : undefined;

    return {
      intent: 'op',
      draft: {
        kind: detectedKind,
        amount,
        method,
        label: text.slice(0, 120),
        ...(counterpartyName ? { counterparty_name: counterpartyName } : {}),
        fiscal: detectFiscal(text),
      },
      confirm: amount >= CONFIRM_THRESHOLD,
      ...(amount >= CONFIRM_THRESHOLD ? { confirm_reason: 'large_amount' } : {}),
      source: 'deterministic',
      raw_text: rawText,
    };
  }

  return {
    intent: 'unknown',
    draft: null,
    confirm: false,
    source: 'deterministic',
    raw_text: rawText,
  };
}

/**
 * Full parse pipeline: deterministic parser first; falls back to LLM tool
 * `extract_operation` ONLY when deterministic result is `unknown` and AI_API_KEY is set.
 * Never writes to the database.
 */
export async function parseOperationText(rawText: string): Promise<ParseResult> {
  const deterministic = parseOperationDeterministic(rawText);
  if (deterministic.intent !== 'unknown' || !env.AI_API_KEY) {
    return deterministic;
  }

  try {
    const client = new OpenAI({
      apiKey: env.AI_API_KEY,
      baseURL: env.AI_BASE_URL,
      timeout: 5000,
    });

    const completion = await client.chat.completions.create({
      model: env.AI_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Extract a single business financial operation from Uzbek or Russian merchant text. Never invent numbers.',
        },
        { role: 'user', content: rawText },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'extract_operation',
            description: 'Extract structured operation intent from merchant utterance',
            parameters: {
              type: 'object',
              properties: {
                intent: {
                  type: 'string',
                  enum: ['op', 'fix', 'rent', 'question', 'report', 'need-amount', 'need-kind', 'unknown'],
                },
                kind: {
                  type: 'string',
                  enum: ['sale', 'buy', 'exp', 'sup', 'nas', 'repaid', 'fix'],
                },
                amount: { type: 'integer' },
                method: { type: 'string', enum: ['naqd', 'karta', 'none'] },
                label: { type: 'string' },
                counterparty_name: { type: 'string' },
              },
              required: ['intent'],
            },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'extract_operation' } },
    });

    const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== 'function') return deterministic;

    const args = JSON.parse(toolCall.function.arguments) as {
      intent: ParsedIntentType;
      kind?: OpKind;
      amount?: number;
      method?: PayMethod;
      label?: string;
      counterparty_name?: string;
    };

    const amount = typeof args.amount === 'number' && args.amount > 0 ? Math.round(args.amount) : null;
    const draft: ParsedOperationDraft | null =
      args.kind && amount
        ? {
            kind: args.kind,
            amount,
            method: args.kind === 'nas' ? 'none' : args.method ?? 'naqd',
            label: args.label ?? rawText.slice(0, 120),
            ...(args.counterparty_name ? { counterparty_name: args.counterparty_name } : {}),
          }
        : null;

    const confirm = Boolean(amount && amount >= CONFIRM_THRESHOLD);

    return {
      intent: args.intent ?? 'unknown',
      draft,
      confirm,
      ...(confirm ? { confirm_reason: 'large_amount' } : {}),
      source: 'llm',
      raw_text: rawText,
    };
  } catch {
    return deterministic;
  }
}
