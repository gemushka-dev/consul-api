import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middlewares/auth.js';
import { idempotencyMiddleware } from '../../middlewares/idempotency.js';
import { validateBody } from '../../middlewares/validate.js';
import { Errors } from '../../utils/errors.js';
import {
  askConsulAndPersist,
  deleteMemoryFact,
  listChatMessages,
  listMemoryFacts,
  listUserChats,
  updateMemoryFact,
} from './consul.service.js';

const uuidSchema = z.string().uuid();

const askSchema = z.object({
  text: z.string().trim().min(1, 'Question text is required').max(2000),
  chat_id: z.string().uuid().optional(),
  route: z.string().trim().max(50).optional(),
});

const patchMemorySchema = z.object({
  value: z.string().trim().min(1).max(1000),
});

export const consulRouter = Router();
consulRouter.use(requireAuth);

consulRouter.post('/ask', idempotencyMiddleware, validateBody(askSchema), async (req, res, next) => {
  try {
    const wantsSse = Boolean(req.headers.accept?.includes('text/event-stream'));

    const reply = await askConsulAndPersist({
      userId: req.user!.id,
      text: req.body.text,
      chatId: req.body.chat_id,
      route: req.body.route,
      lang: req.lang,
    });

    if (!wantsSse) {
      res.json(reply);
      return;
    }

    // Stream text chunks via SSE, then emit final structured Reply JSON
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const words = reply.text.split(/(\s+)/);
    const chunkSize = 6;
    for (let i = 0; i < words.length; i += chunkSize) {
      const chunk = words.slice(i, i + chunkSize).join('');
      res.write(`event: delta\ndata: ${JSON.stringify({ chunk })}\n\n`);
    }

    res.write(`event: reply\ndata: ${JSON.stringify(reply)}\n\n`);
    res.write(`event: done\ndata: {}\n\n`);
    res.end();
  } catch (err) {
    next(err);
  }
});

export const chatsRouter = Router();
chatsRouter.use(requireAuth);

chatsRouter.get('/', async (req, res, next) => {
  try {
    const items = await listUserChats(req.user!.id);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

chatsRouter.get('/:id/messages', async (req, res, next) => {
  try {
    const parsedId = uuidSchema.safeParse(req.params.id);
    if (!parsedId.success) {
      throw Errors.notFound('chat_not_found', 'Chat not found');
    }
    const items = await listChatMessages(req.user!.id, parsedId.data);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

export const memoryRouter = Router();
memoryRouter.use(requireAuth);

memoryRouter.get('/', async (req, res, next) => {
  try {
    const items = await listMemoryFacts(req.user!.id);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

memoryRouter.patch('/:id', validateBody(patchMemorySchema), async (req, res, next) => {
  try {
    const parsedId = uuidSchema.safeParse(req.params.id);
    if (!parsedId.success) {
      throw Errors.notFound('memory_fact_not_found', 'Memory fact not found');
    }
    const fact = await updateMemoryFact(req.user!.id, parsedId.data, req.body.value);
    res.json({ fact });
  } catch (err) {
    next(err);
  }
});

memoryRouter.delete('/:id', async (req, res, next) => {
  try {
    const parsedId = uuidSchema.safeParse(req.params.id);
    if (!parsedId.success) {
      throw Errors.notFound('memory_fact_not_found', 'Memory fact not found');
    }
    await deleteMemoryFact(req.user!.id, parsedId.data);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
