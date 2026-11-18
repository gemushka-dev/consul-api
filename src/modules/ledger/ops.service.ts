import { and, desc, eq, gte, isNull, lte, or, lt } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/db.js';
import {
  businesses,
  counterparties,
  obligations,
  ops,
  type OpRow,
} from '../../db/schema.js';
import type { SupportedLang } from '../../types/express.d.js';
import { Errors } from '../../utils/errors.js';
import { toSafeInt } from '../../utils/money.js';
import { computeTodayDashboard, type TodayDashboard } from './ledger.math.js';

export const createOpSchema = z
  .object({
    kind: z.enum(['sale', 'buy', 'exp', 'sup', 'nas', 'repaid', 'fix', 'opening']),
    amount: z.number().int('Amount must be an integer in UZS'),
    method: z.enum(['naqd', 'karta', 'none']).default('naqd'),
    label: z.string().trim().max(300).optional(),
    counterparty_id: z.string().uuid().optional(),
    counterparty_name: z.string().trim().min(1).max(120).optional(),
    counterparty_phone: z.string().trim().max(20).optional(),
    fiscal: z.boolean().default(false),
    source: z.enum(['text', 'voice', 'photo', 'manual', 'seed']).default('manual'),
    raw_text: z.string().max(1000).optional(),
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
      .optional(),
    occurred_at: z.string().datetime().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.kind === 'fix') {
      if (data.amount === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['amount'],
          message: 'Fix delta amount must be non-zero',
        });
      }
    } else if (data.amount <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: 'Amount must be greater than 0',
      });
    }
  });

export type CreateOpInput = z.infer<typeof createOpSchema>;

export function serializeOp(op: OpRow) {
  return {
    id: op.id,
    kind: op.kind,
    amount: toSafeInt(op.amount),
    method: op.method,
    label: op.label,
    counterparty_id: op.counterpartyId,
    fiscal: op.fiscal,
    source: op.source,
    raw_text: op.rawText,
    items: op.items ?? null,
    occurred_at: op.occurredAt.toISOString(),
  };
}

export async function loadUserTodayDashboard(
  userId: string,
  lang: SupportedLang = 'uz',
  now: Date = new Date(),
): Promise<TodayDashboard> {
  const db = getDb();
  const [opRows, obRows, bizRows, cpRows] = await Promise.all([
    db.select().from(ops).where(and(eq(ops.userId, userId), isNull(ops.deletedAt))),
    db.select().from(obligations).where(eq(obligations.userId, userId)),
    db.select().from(businesses).where(eq(businesses.userId, userId)).limit(1),
    db.select().from(counterparties).where(eq(counterparties.userId, userId)),
  ]);

  return computeTodayDashboard({
    ops: opRows,
    obligations: obRows,
    business: bizRows[0] ?? null,
    counterparties: cpRows,
    now,
    lang,
  });
}

export async function createOperation(
  userId: string,
  input: CreateOpInput,
  idempotencyKey?: string,
  lang: SupportedLang = 'uz',
) {
  const db = getDb();

  if (idempotencyKey) {
    const existing = await db
      .select()
      .from(ops)
      .where(and(eq(ops.userId, userId), eq(ops.idempotencyKey, idempotencyKey)))
      .limit(1);

    if (existing[0]) {
      const today = await loadUserTodayDashboard(userId, lang);
      return {
        op: serializeOp(existing[0]),
        free_before: today.view.free,
        free_after: today.view.free,
        replayed: true,
      };
    }
  }

  const before = await loadUserTodayDashboard(userId, lang);

  let counterpartyId = input.counterparty_id ?? null;

  if (!counterpartyId && input.counterparty_name) {
    const cpKind = input.kind === 'sup' ? 'supplier' : 'customer';
    const existingCps = await db
      .select()
      .from(counterparties)
      .where(and(eq(counterparties.userId, userId), eq(counterparties.kind, cpKind)));

    const normalizedName = input.counterparty_name.trim().toLowerCase();
    const matched = existingCps.find((c) => c.name.trim().toLowerCase() === normalizedName);

    if (matched) {
      counterpartyId = matched.id;
    } else {
      const createdCp = await db
        .insert(counterparties)
        .values({
          userId,
          name: input.counterparty_name.trim(),
          kind: cpKind,
          phone: input.counterparty_phone ?? null,
        })
        .returning();
      counterpartyId = createdCp[0]!.id;
    }
  } else if (counterpartyId) {
    const owned = await db
      .select()
      .from(counterparties)
      .where(and(eq(counterparties.id, counterpartyId), eq(counterparties.userId, userId)))
      .limit(1);
    if (!owned[0]) {
      throw Errors.notFound('counterparty_not_found', 'Counterparty not found');
    }
  }

  const method = input.kind === 'nas' ? 'none' : input.method;

  const inserted = await db
    .insert(ops)
    .values({
      userId,
      kind: input.kind,
      amount: input.amount,
      method,
      label: input.label ?? null,
      counterpartyId,
      fiscal: input.fiscal,
      source: input.source,
      rawText: input.raw_text ?? null,
      items: input.items ?? null,
      occurredAt: input.occurred_at ? new Date(input.occurred_at) : new Date(),
      idempotencyKey: idempotencyKey ?? null,
    })
    .returning();

  const after = await loadUserTodayDashboard(userId, lang);

  return {
    op: serializeOp(inserted[0]!),
    free_before: before.view.free,
    free_after: after.view.free,
  };
}

interface CursorPayload {
  occurredAt: string;
  id: string;
}

function encodeCursor(op: OpRow): string {
  const payload: CursorPayload = {
    occurredAt: op.occurredAt.toISOString(),
    id: op.id,
  };
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as CursorPayload;
    if (parsed && typeof parsed.occurredAt === 'string' && typeof parsed.id === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export async function listOperations(
  userId: string,
  params: {
    cursor?: string;
    limit?: number;
    kind?: string;
    from?: string;
    to?: string;
  },
) {
  const db = getDb();
  const limit = Math.min(100, Math.max(1, params.limit ?? 20));
  const conditions = [eq(ops.userId, userId), isNull(ops.deletedAt)];

  if (params.kind) {
    conditions.push(eq(ops.kind, params.kind));
  }
  if (params.from) {
    const fromDate = new Date(params.from);
    if (!Number.isNaN(fromDate.getTime())) {
      conditions.push(gte(ops.occurredAt, fromDate));
    }
  }
  if (params.to) {
    const toDate = new Date(params.to);
    if (!Number.isNaN(toDate.getTime())) {
      conditions.push(lte(ops.occurredAt, toDate));
    }
  }
  if (params.cursor) {
    const cur = decodeCursor(params.cursor);
    if (!cur) {
      throw Errors.badRequest('invalid_cursor', 'Invalid pagination cursor', 'cursor');
    }
    const curDate = new Date(cur.occurredAt);
    conditions.push(
      or(
        lt(ops.occurredAt, curDate),
        and(eq(ops.occurredAt, curDate), lt(ops.id, cur.id)),
      )!,
    );
  }

  const rows = await db
    .select()
    .from(ops)
    .where(and(...conditions))
    .orderBy(desc(ops.occurredAt), desc(ops.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map(serializeOp),
    next_cursor: hasMore && last ? encodeCursor(last) : null,
    has_more: hasMore,
  };
}

export async function softDeleteOperation(
  userId: string,
  opId: string,
  lang: SupportedLang = 'uz',
) {
  const db = getDb();
  const existing = await db
    .select()
    .from(ops)
    .where(and(eq(ops.id, opId), eq(ops.userId, userId), isNull(ops.deletedAt)))
    .limit(1);

  if (!existing[0]) {
    throw Errors.notFound('op_not_found', 'Operation not found');
  }

  await db
    .update(ops)
    .set({ deletedAt: new Date() })
    .where(and(eq(ops.id, opId), eq(ops.userId, userId)));

  const today = await loadUserTodayDashboard(userId, lang);

  return {
    deleted_id: opId,
    today,
  };
}
