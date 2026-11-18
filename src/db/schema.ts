import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export interface UserPrefs {
  largeFont?: boolean;
  voiceReply?: boolean;
  voiceSpeed?: number;
}

export interface OpLineItem {
  name: string;
  qty?: number;
  unit?: string;
  price?: number;
  total: number;
}

// 1. Пользователи (вход по телефону + 2 согласия)
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  phone: varchar('phone', { length: 20 }).unique(),
  email: varchar('email', { length: 255 }).unique(),
  passwordHash: text('password_hash'),
  lang: varchar('lang', { length: 5 }).notNull().default('uz'),
  role: varchar('role', { length: 20 }).notNull().default('user'),
  consentAt: timestamp('consent_at', { withTimezone: true }),
  consentVersion: varchar('consent_version', { length: 20 }),
  statsConsentAt: timestamp('stats_consent_at', { withTimezone: true }),
  prefs: jsonb('prefs').$type<UserPrefs>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 2. Профиль бизнеса (онбординг + срезы для Палаты)
export const businesses = pgTable('businesses', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  trade: text('trade').notNull(),
  sector: varchar('sector', { length: 30 }).notNull(),
  market: varchar('market', { length: 30 }).notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  regime: varchar('regime', { length: 20 }).notNull(),
  reserve: bigint('reserve', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// История смены статуса (метрика "перешли в белый бизнес" для Палаты)
export const businessStatusHistory = pgTable('business_status_history', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  oldStatus: varchar('old_status', { length: 20 }),
  newStatus: varchar('new_status', { length: 20 }).notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
});

// 3. Контрагенты (должники по насия и поставщики)
export const counterparties = pgTable('counterparties', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: varchar('kind', { length: 20 }).notNull(), // 'customer' | 'supplier'
  phone: varchar('phone', { length: 20 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 4. Журнал операций (Единственный источник истины)
export const ops = pgTable(
  'ops',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 20 }).notNull(), // 'sale' | 'buy' | 'exp' | 'sup' | 'nas' | 'repaid' | 'fix' | 'opening'
    amount: bigint('amount', { mode: 'number' }).notNull(),
    method: varchar('method', { length: 10 }).notNull(), // 'naqd' | 'karta' | 'none'
    label: text('label'),
    counterpartyId: uuid('counterparty_id').references(() => counterparties.id, {
      onDelete: 'set null',
    }),
    fiscal: boolean('fiscal').notNull().default(false),
    source: varchar('source', { length: 20 }).notNull().default('manual'),
    rawText: text('raw_text'),
    items: jsonb('items').$type<OpLineItem[] | null>(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    idempotencyKey: varchar('idempotency_key', { length: 100 }),
  },
  (table) => [
    unique('ops_user_id_idempotency_key_unique').on(table.userId, table.idempotencyKey),
    index('idx_ops_user_active')
      .on(table.userId, table.occurredAt)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

// 5. Обязательные платежи (аренда, поставщики, кредиты)
export const obligations = pgTable('obligations', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 20 }).notNull(), // 'rent' | 'supplier' | 'loan' | 'other'
  title: text('title').notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  dueDay: integer('due_day'),
  dueDate: date('due_date'),
  recurring: boolean('recurring').notNull().default(true),
  counterpartyId: uuid('counterparty_id').references(() => counterparties.id, {
    onDelete: 'set null',
  }),
});

// 6. Память Consul и Чаты
export const memoryFacts = pgTable('memory_facts', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  key: varchar('key', { length: 100 }).notNull(),
  value: text('value').notNull(),
  sourceChatId: uuid('source_chat_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const chats = pgTable('chats', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: text('title'),
  topic: varchar('topic', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable('messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  chatId: uuid('chat_id')
    .notNull()
    .references(() => chats.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 20 }).notNull(), // 'user' | 'assistant'
  text: text('text').notNull(),
  reply: jsonb('reply').$type<Record<string, unknown> | null>(),
  toolCalls: jsonb('tool_calls').$type<Array<Record<string, unknown>> | null>(),
  model: varchar('model', { length: 50 }),
  tokensIn: integer('tokens_in').default(0),
  tokensOut: integer('tokens_out').default(0),
  latencyMs: integer('latency_ms').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 7. Опросы и Снимки Палаты (Задача 21)
export const surveyAnswers = pgTable('survey_answers', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  question: varchar('question', { length: 100 }).notNull(),
  answer: varchar('answer', { length: 100 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const palataSnapshots = pgTable(
  'palata_snapshots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    periodEnd: date('period_end').notNull(),
    windowDays: integer('window_days').notNull(), // 30 | 90
    cut: varchar('cut', { length: 20 }).notNull(), // 'all' | 'sector' | 'market'
    cutKey: varchar('cut_key', { length: 50 }).notNull(),
    n: integer('n').notNull(),
    metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('palata_snapshots_unique_slice').on(
      table.periodEnd,
      table.windowDays,
      table.cut,
      table.cutKey,
    ),
    check('palata_snapshots_k_anon_check', sql`${table.n} >= 5`),
  ],
);

// 8. История расчётов и Бизнес-планы
export const calculationHistory = pgTable('calculation_history', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 20 }).notNull(), // 'loan' | 'tax' | 'breakeven'
  input: jsonb('input').$type<Record<string, unknown>>().notNull(),
  result: jsonb('result').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const businessPlans = pgTable('business_plans', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  input: jsonb('input').$type<Record<string, unknown>>().notNull(),
  content: text('content'),
  structured: jsonb('structured').$type<Record<string, unknown> | null>(),
  toolCalls: jsonb('tool_calls').$type<Array<Record<string, unknown>> | null>(),
  lang: varchar('lang', { length: 5 }).notNull().default('uz'),
  model: varchar('model', { length: 50 }),
  tokensIn: integer('tokens_in').default(0),
  tokensOut: integer('tokens_out').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type BusinessRow = typeof businesses.$inferSelect;
export type CounterpartyRow = typeof counterparties.$inferSelect;
export type OpRow = typeof ops.$inferSelect;
export type ObligationRow = typeof obligations.$inferSelect;
export type MemoryFactRow = typeof memoryFacts.$inferSelect;
export type ChatRow = typeof chats.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type PalataSnapshotRow = typeof palataSnapshots.$inferSelect;
