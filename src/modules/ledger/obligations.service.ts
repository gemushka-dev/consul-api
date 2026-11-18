import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/db.js';
import { obligations, type ObligationRow } from '../../db/schema.js';
import { Errors } from '../../utils/errors.js';
import { toSafeInt } from '../../utils/money.js';

export const createObligationSchema = z
  .object({
    kind: z.enum(['rent', 'supplier', 'loan', 'other']),
    title: z.string().trim().min(1, 'Title is required').max(200),
    amount: z.number().int().positive('Amount must be a positive integer'),
    due_day: z.number().int().min(1).max(31).nullable().optional(),
    due_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'due_date must be YYYY-MM-DD')
      .nullable()
      .optional(),
    recurring: z.boolean().default(true),
    counterparty_id: z.string().uuid().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.recurring && !data.due_day) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['due_day'],
        message: 'due_day (1-31) is required for recurring obligations',
      });
    }
    if (!data.recurring && !data.due_date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['due_date'],
        message: 'due_date (YYYY-MM-DD) is required for one-time obligations',
      });
    }
  });

export const patchObligationSchema = z.object({
  kind: z.enum(['rent', 'supplier', 'loan', 'other']).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  amount: z.number().int().positive().optional(),
  due_day: z.number().int().min(1).max(31).nullable().optional(),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  recurring: z.boolean().optional(),
  counterparty_id: z.string().uuid().nullable().optional(),
});

export function serializeObligation(row: ObligationRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    amount: toSafeInt(row.amount),
    due_day: row.dueDay,
    due_date: row.dueDate,
    recurring: row.recurring,
    counterparty_id: row.counterpartyId,
  };
}

export async function listObligations(userId: string) {
  const db = getDb();
  const rows = await db.select().from(obligations).where(eq(obligations.userId, userId));
  return rows.map(serializeObligation);
}

export async function createObligation(
  userId: string,
  input: z.infer<typeof createObligationSchema>,
) {
  const db = getDb();
  const inserted = await db
    .insert(obligations)
    .values({
      userId,
      kind: input.kind,
      title: input.title,
      amount: input.amount,
      dueDay: input.due_day ?? null,
      dueDate: input.due_date ?? null,
      recurring: input.recurring,
      counterpartyId: input.counterparty_id ?? null,
    })
    .returning();

  return serializeObligation(inserted[0]!);
}

export async function updateObligation(
  userId: string,
  id: string,
  input: z.infer<typeof patchObligationSchema>,
) {
  const db = getDb();
  const existing = await db
    .select()
    .from(obligations)
    .where(and(eq(obligations.id, id), eq(obligations.userId, userId)))
    .limit(1);

  if (!existing[0]) {
    throw Errors.notFound('obligation_not_found', 'Obligation not found');
  }

  const updated = await db
    .update(obligations)
    .set({
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.amount !== undefined ? { amount: input.amount } : {}),
      ...(input.due_day !== undefined ? { dueDay: input.due_day } : {}),
      ...(input.due_date !== undefined ? { dueDate: input.due_date } : {}),
      ...(input.recurring !== undefined ? { recurring: input.recurring } : {}),
      ...(input.counterparty_id !== undefined ? { counterpartyId: input.counterparty_id } : {}),
    })
    .where(and(eq(obligations.id, id), eq(obligations.userId, userId)))
    .returning();

  return serializeObligation(updated[0]!);
}

export async function deleteObligation(userId: string, id: string): Promise<void> {
  const db = getDb();
  const existing = await db
    .select()
    .from(obligations)
    .where(and(eq(obligations.id, id), eq(obligations.userId, userId)))
    .limit(1);

  if (!existing[0]) {
    throw Errors.notFound('obligation_not_found', 'Obligation not found');
  }

  await db.delete(obligations).where(and(eq(obligations.id, id), eq(obligations.userId, userId)));
}
