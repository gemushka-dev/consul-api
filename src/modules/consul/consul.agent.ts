import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  buildAssistantToolCallMessage,
  createAiClient,
  getModelChatOptions,
  hasAiApiKey,
  stripJsonCodeFences,
} from '../../config/ai.js';
import { env } from '../../config/env.js';
import { redis } from '../../config/redis.js';
import type { SupportedLang } from '../../types/express.d.js';
import { Errors } from '../../utils/errors.js';
import { toTashkentDateString } from '../../utils/time.js';
import { buildDeterministicFallback } from './consul.fallbacks.js';
import {
  CONSUL_TOOLS_SCHEMA,
  executeConsulTool,
  unmaskPiiText,
  type PendingOpDraft,
  type ToolCallTrace,
  type ToolExecutionContext,
} from './consul.tools.js';
import { verifyNumbers, type ConsulReplyCard } from './verifyNumbers.js';

const MAX_AGENT_STEPS = 8;

export interface ConsulAgentInput {
  userId: string;
  text: string;
  route?: string;
  lang: SupportedLang;
  chatId?: string;
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
}

export interface ConsulAgentResponse {
  text: string;
  card: ConsulReplyCard | null;
  pending_op: PendingOpDraft | null;
  fallback: boolean;
  verified: boolean;
  tool_calls: ToolCallTrace[];
  model: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
}

const SYSTEM_PROMPT = `You are Consul, a practical financial co-pilot for small bazaar and retail entrepreneurs in Uzbekistan.
STRICT RULES:
1. NEVER invent, estimate, or guess ANY monetary amount, tax, percentage, or date. Always call tools (get_today, get_months, list_debtors, calculate_loan, calculate_tax, calculate_breakeven, safe_loan, simulate_cashflow) to get exact numbers.
2. NEVER write directly to the ledger; if the user wants to record an operation, call draft_operation so the UI displays a confirmation button.
3. Debtor names are masked as D1, D2, etc. Refer to them by those exact codes (D1, D2).
4. Respond concisely in the user's language (uz / ru / en).
5. You may return either plain text or a JSON object: {"text":"...","card":{"title":"...","value":"...","rows":[{"label":"...","value":"..."}]}}.`;

async function enforceDailyAiLimit(userId: string): Promise<void> {
  const day = toTashkentDateString(new Date());
  const key = `ai:daily:${userId}:${day}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 24 * 60 * 60);
  }
  if (count > env.AI_DAILY_LIMIT) {
    throw Errors.tooManyRequests(
      'ai_daily_limit_exceeded',
      `Daily AI limit of ${env.AI_DAILY_LIMIT} requests reached`,
    );
  }
}

function tryParseStructuredReply(raw: string): { text: string; card: ConsulReplyCard | null } {
  const cleaned = stripJsonCodeFences(raw);
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
    try {
      const parsed = JSON.parse(cleaned) as { text?: string; card?: ConsulReplyCard | null };
      if (typeof parsed.text === 'string' && parsed.text.length > 0) {
        return { text: parsed.text, card: parsed.card ?? null };
      }
    } catch {
      // Fall through to plain text
    }
  }
  return { text: raw.trim(), card: null };
}

function unmaskCard(card: ConsulReplyCard | null, maskMap: Map<string, string>): ConsulReplyCard | null {
  if (!card) return null;
  return {
    ...card,
    title: unmaskPiiText(card.title, maskMap),
    ...(card.subtitle ? { subtitle: unmaskPiiText(card.subtitle, maskMap) } : {}),
    ...(card.value !== undefined
      ? {
          value:
            typeof card.value === 'string' ? unmaskPiiText(card.value, maskMap) : card.value,
        }
      : {}),
    ...(card.rows
      ? {
          rows: card.rows.map((r) => ({
            label: unmaskPiiText(r.label, maskMap),
            value: typeof r.value === 'string' ? unmaskPiiText(r.value, maskMap) : r.value,
          })),
        }
      : {}),
  };
}

export async function runConsulAgent(input: ConsulAgentInput): Promise<ConsulAgentResponse> {
  const startedAt = Date.now();
  await enforceDailyAiLimit(input.userId);

  // If no AI API key is configured, immediately run deterministic grounded fallback
  if (!hasAiApiKey()) {
    const fb = await buildDeterministicFallback({
      userId: input.userId,
      text: input.text,
      route: input.route,
      lang: input.lang,
    });
    return {
      text: fb.text,
      card: fb.card,
      pending_op: fb.pending_op,
      fallback: true,
      verified: true,
      tool_calls: fb.tool_calls,
      model: 'deterministic-fallback',
      tokens_in: 0,
      tokens_out: 0,
      latency_ms: Date.now() - startedAt,
    };
  }

  const ctx: ToolExecutionContext = {
    userId: input.userId,
    lang: input.lang,
    chatId: input.chatId,
    piiMaskMap: new Map(),
    pendingOp: null,
  };

  const traces: ToolCallTrace[] = [];
  const toolOutputs: unknown[] = [];
  let tokensIn = 0;
  let tokensOut = 0;

  try {
    const client = createAiClient(env.AI_TIMEOUT_MS);
    const modelOpts = getModelChatOptions(env.AI_MODEL, env.AI_THINKING, 0.2);

    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `${SYSTEM_PROMPT}\nUser preferred language: ${input.lang}. Route hint: ${input.route ?? 'general'}.`,
      },
      ...(input.history ?? []).slice(-6).map((h) => ({
        role: h.role,
        content: h.text,
      })),
      { role: 'user', content: input.text },
    ];

    let finalContent = '';

    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      const requestPayload = {
        model: env.AI_MODEL,
        ...modelOpts,
        messages,
        tools: CONSUL_TOOLS_SCHEMA,
        tool_choice: 'auto' as const,
      };
      const completion = await client.chat.completions.create(
        requestPayload as Parameters<typeof client.chat.completions.create>[0] & { stream?: false },
      );

      tokensIn += completion.usage?.prompt_tokens ?? 0;
      tokensOut += completion.usage?.completion_tokens ?? 0;

      const msg = completion.choices[0]?.message;
      if (!msg) break;

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        messages.push(buildAssistantToolCallMessage(msg));

        for (const tc of msg.tool_calls) {
          if (tc.type !== 'function') continue;
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
          } catch {
            parsedArgs = {};
          }

          const output = await executeConsulTool(tc.function.name, parsedArgs, ctx);
          traces.push({ name: tc.function.name, args: parsedArgs, output });
          toolOutputs.push(output);

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(output),
          });
        }
        continue;
      }

      finalContent = msg.content ?? '';
      break;
    }

    if (!finalContent) {
      throw new Error('Empty LLM response');
    }

    const structured = tryParseStructuredReply(finalContent);
    const verification = verifyNumbers(structured, toolOutputs, input.text);

    if (!verification.ok) {
      // Hallucinated number detected -> discard LLM answer and return deterministic fallback
      const fb = await buildDeterministicFallback({
        userId: input.userId,
        text: input.text,
        route: input.route,
        lang: input.lang,
      });
      return {
        text: fb.text,
        card: fb.card,
        pending_op: fb.pending_op ?? ctx.pendingOp,
        fallback: true,
        verified: true,
        tool_calls: [...traces, ...fb.tool_calls],
        model: `${env.AI_MODEL}:fallback-ungrounded`,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        latency_ms: Date.now() - startedAt,
      };
    }

    return {
      text: unmaskPiiText(structured.text, ctx.piiMaskMap),
      card: unmaskCard(structured.card, ctx.piiMaskMap),
      pending_op: ctx.pendingOp,
      fallback: false,
      verified: true,
      tool_calls: traces,
      model: env.AI_MODEL,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      latency_ms: Date.now() - startedAt,
    };
  } catch {
    const fb = await buildDeterministicFallback({
      userId: input.userId,
      text: input.text,
      route: input.route,
      lang: input.lang,
    });
    return {
      text: fb.text,
      card: fb.card,
      pending_op: fb.pending_op ?? ctx.pendingOp,
      fallback: true,
      verified: true,
      tool_calls: [...traces, ...fb.tool_calls],
      model: 'deterministic-fallback',
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      latency_ms: Date.now() - startedAt,
    };
  }
}
