import { and, asc, desc, eq } from 'drizzle-orm';
import { getDb } from '../../config/db.js';
import { chats, memoryFacts, messages } from '../../db/schema.js';
import type { SupportedLang } from '../../types/express.d.js';
import { Errors } from '../../utils/errors.js';
import { runConsulAgent } from './consul.agent.js';

export async function askConsulAndPersist(params: {
  userId: string;
  text: string;
  chatId?: string;
  route?: string;
  lang: SupportedLang;
}) {
  const db = getDb();
  let chatId = params.chatId;

  if (chatId) {
    const owned = await db
      .select()
      .from(chats)
      .where(and(eq(chats.id, chatId), eq(chats.userId, params.userId)))
      .limit(1);
    if (!owned[0]) {
      throw Errors.notFound('chat_not_found', 'Chat not found');
    }
  } else {
    const created = await db
      .insert(chats)
      .values({
        userId: params.userId,
        title: params.text.slice(0, 80),
        topic: params.route ?? 'general',
      })
      .returning();
    chatId = created[0]!.id;
  }

  const prevMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.createdAt))
    .limit(6);

  const history = prevMessages.reverse().map((m) => ({
    role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
    text: m.text,
  }));

  await db.insert(messages).values({
    chatId,
    role: 'user',
    text: params.text,
  });

  const agentResult = await runConsulAgent({
    userId: params.userId,
    text: params.text,
    route: params.route,
    lang: params.lang,
    chatId,
    history,
  });

  const replyPayload = {
    chat_id: chatId,
    text: agentResult.text,
    card: agentResult.card,
    pending_op: agentResult.pending_op,
    fallback: agentResult.fallback,
    verified: agentResult.verified,
    model: agentResult.model,
    latency_ms: agentResult.latency_ms,
  };

  await db.insert(messages).values({
    chatId,
    role: 'assistant',
    text: agentResult.text,
    reply: replyPayload as unknown as Record<string, unknown>,
    toolCalls: agentResult.tool_calls as unknown as Array<Record<string, unknown>>,
    model: agentResult.model,
    tokensIn: agentResult.tokens_in,
    tokensOut: agentResult.tokens_out,
    latencyMs: agentResult.latency_ms,
  });

  return replyPayload;
}

export async function listUserChats(userId: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(chats)
    .where(eq(chats.userId, userId))
    .orderBy(desc(chats.createdAt))
    .limit(50);

  return rows.map((c) => ({
    id: c.id,
    title: c.title,
    topic: c.topic,
    created_at: c.createdAt.toISOString(),
  }));
}

export async function listChatMessages(userId: string, chatId: string) {
  const db = getDb();
  const owned = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .limit(1);

  if (!owned[0]) {
    throw Errors.notFound('chat_not_found', 'Chat not found');
  }

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.createdAt));

  return rows.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    reply: m.reply,
    tool_calls: m.toolCalls,
    model: m.model,
    tokens_in: m.tokensIn,
    tokens_out: m.tokensOut,
    latency_ms: m.latencyMs,
    created_at: m.createdAt.toISOString(),
  }));
}

export async function listMemoryFacts(userId: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(memoryFacts)
    .where(eq(memoryFacts.userId, userId))
    .orderBy(desc(memoryFacts.updatedAt));

  return rows.map((f) => ({
    id: f.id,
    key: f.key,
    value: f.value,
    source_chat_id: f.sourceChatId,
    updated_at: f.updatedAt.toISOString(),
  }));
}

export async function updateMemoryFact(userId: string, id: string, value: string) {
  const db = getDb();
  const updated = await db
    .update(memoryFacts)
    .set({ value, updatedAt: new Date() })
    .where(and(eq(memoryFacts.id, id), eq(memoryFacts.userId, userId)))
    .returning();

  if (!updated[0]) {
    throw Errors.notFound('memory_fact_not_found', 'Memory fact not found');
  }

  return {
    id: updated[0].id,
    key: updated[0].key,
    value: updated[0].value,
    source_chat_id: updated[0].sourceChatId,
    updated_at: updated[0].updatedAt.toISOString(),
  };
}

export async function deleteMemoryFact(userId: string, id: string): Promise<void> {
  const db = getDb();
  const deleted = await db
    .delete(memoryFacts)
    .where(and(eq(memoryFacts.id, id), eq(memoryFacts.userId, userId)))
    .returning();

  if (!deleted[0]) {
    throw Errors.notFound('memory_fact_not_found', 'Memory fact not found');
  }
}
