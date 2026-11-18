import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { seedPalataData } from '../src/scripts/seed-palata.js';
import { setupTestDb, teardownTestDb } from './helpers/testDb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

describe('E2E Smoke Suite: Full Pitch Demo Scenario & Secret Hygiene', () => {
  beforeAll(async () => {
    await setupTestDb();
    await seedPalataData(812);
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('passes health probes and exposes OpenAPI 3.0.3 spec', async () => {
    await request(app).get('/api/v1/healthz').expect(200);
    const ready = await request(app).get('/api/v1/readyz').expect(200);
    expect(ready.body.status).toBe('ready');
    expect(ready.body.checks).toEqual({ postgres: 'ok', redis: 'ok' });

    const doc = await request(app).get('/api/docs/openapi.json').expect(200);
    expect(doc.body.openapi).toBe('3.0.3');
    expect(doc.body.info.version).toBe('2.0.0');
  });

  it('enforces OTP lockout after 3 wrong attempts and rotates refresh tokens with blacklist', async () => {
    const phone = '+998909876543';
    await request(app).post('/api/v1/auth/otp/send').send({ phone }).expect(204);

    // 3 wrong attempts -> 401, 401, 429 locked
    await request(app).post('/api/v1/auth/otp/verify').send({ phone, code: '000001' }).expect(401);
    await request(app).post('/api/v1/auth/otp/verify').send({ phone, code: '000002' }).expect(401);
    const lockRes = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ phone, code: '000003' })
      .expect(429);
    expect(lockRes.body.error.code).toBe('otp_locked');

    // Fresh phone with demo OTP -> verify -> refresh rotation -> replay blocked
    const goodPhone = '+998901119988';
    const verifyRes = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ phone: goodPhone, code: '123456' })
      .expect(200);
    expect(verifyRes.body.is_new).toBe(true);

    const cookies = verifyRes.headers['set-cookie'] as unknown as string[];
    const refreshCookie = cookies.find((c) => c.startsWith('refresh_token='))!;
    expect(refreshCookie).toBeTruthy();

    // First refresh succeeds and blacklists the old refresh token
    await request(app).post('/api/v1/auth/refresh').set('Cookie', [refreshCookie]).expect(200);
    // Reusing the old refresh token MUST fail with 401 token_revoked
    const replay = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [refreshCookie])
      .expect(401);
    expect(replay.body.error.code).toBe('token_revoked');
  });

  it('executes complete pitch scenario: Demo -> Voice -> Parse -> Op -> Undo -> Loan -> Consul -> Reports -> Palata', async () => {
    const agent = request.agent(app);

    // 1. Demo login (Dilnoza benchmark)
    const demo = await agent.post('/api/v1/auth/demo').expect(200);
    expect(demo.body.user.phone).toBe('+998901234567');

    const todayInitial = await agent.get('/api/v1/ledger/today').expect(200);
    expect(todayInitial.body.view.cash).toBe(12_000_000);
    expect(todayInitial.body.view.obligations).toBe(6_600_000);
    expect(todayInitial.body.view.reserve).toBe(1_200_000);
    expect(todayInitial.body.view.free).toBe(4_200_000);

    // 2. Voice STT -> Deterministic Parse -> Create Op (Idempotent) -> Soft Delete (Undo)
    const sttRes = await agent
      .post('/api/v1/voice/stt')
      .attach('audio', Buffer.from('fake-webm-audio-payload'), {
        filename: 'speech.webm',
        contentType: 'audio/webm',
      })
      .expect(200);
    expect(sttRes.body.text).toBe('bugun 1,2 mln sotdim');

    const parsedRes = await agent
      .post('/api/v1/ops/parse')
      .send({ text: sttRes.body.text })
      .expect(200);
    expect(parsedRes.body.intent).toBe('op');
    expect(parsedRes.body.draft.kind).toBe('sale');
    expect(parsedRes.body.draft.amount).toBe(1_200_000);

    const created1 = await agent
      .post('/api/v1/ops')
      .set('Idempotency-Key', 'pitch-voice-op-1')
      .send({ ...parsedRes.body.draft, source: 'voice' })
      .expect(201);
    expect(created1.body.free_before).toBe(4_200_000);
    // +1,200,000 sale increases 1% tax by 12,000 => net free increase = +1,188,000
    expect(created1.body.free_after).toBe(5_388_000);

    // Replay same Idempotency-Key must return exact same op id
    const created2 = await agent
      .post('/api/v1/ops')
      .set('Idempotency-Key', 'pitch-voice-op-1')
      .send({ ...parsedRes.body.draft, source: 'voice' })
      .expect(201);
    expect(created2.body.op.id).toBe(created1.body.op.id);

    // Soft delete (Undo) restores free back to 4,200,000
    const undoRes = await agent.delete(`/api/v1/ops/${created1.body.op.id}`).expect(200);
    expect(undoRes.body.today.view.free).toBe(4_200_000);

    // 3. Debtors & Reminder + Photo Receipt + TTS Cache
    const debtorsRes = await agent.get('/api/v1/debtors').expect(200);
    expect(debtorsRes.body.items.length).toBeGreaterThanOrEqual(2);
    const firstDebtorId = debtorsRes.body.items[0].id as string;

    const reminderRes = await agent
      .get(`/api/v1/debtors/${firstDebtorId}/reminder?lang=ru`)
      .expect(200);
    expect(reminderRes.body.text).toContain('Здравствуйте');

    const photoRes = await agent
      .post('/api/v1/photo')
      .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), {
        filename: 'receipt.jpg',
        contentType: 'image/jpeg',
      })
      .expect(200);
    expect(photoRes.body.draft_ops.length).toBeGreaterThanOrEqual(1);

    const tts1 = await agent
      .post('/api/v1/voice/tts')
      .send({ text: 'Можно потратить 4 200 000 сум', speed: 1.0 })
      .expect(200);
    expect(tts1.headers['x-tts-cache']).toBe('MISS');
    const tts2 = await agent
      .post('/api/v1/voice/tts')
      .send({ text: 'Можно потратить 4 200 000 сум', speed: 1.0 })
      .expect(200);
    expect(tts2.headers['x-tts-cache']).toBe('HIT');

    // 4. Credit Calculator (34M @ 24% / 24m = 1,797,617) + Consul AI (JSON & SSE)
    const loanRes = await agent
      .post('/api/v1/calculator/calculate')
      .send({ principal: 34_000_000, annual_rate: 24, months: 24, kind: 'annuity' })
      .expect(200);
    expect(loanRes.body.monthly_payment).toBe(1_797_617);

    const askRes = await agent
      .post('/api/v1/consul/ask?lang=ru')
      .set('Idempotency-Key', 'pitch-ask-1')
      .send({ text: 'Могу ли я взять кредит 34 млн под 24% на 24 месяца?', route: 'loan' })
      .expect(200);
    expect(askRes.body.verified).toBe(true);
    expect(askRes.body.text).toContain('1 797 617');
    expect(askRes.body.chat_id).toBeTruthy();

    // SSE stream test
    const sseRes = await agent
      .post('/api/v1/consul/ask')
      .set('Accept', 'text/event-stream')
      .send({ text: 'Bugungi holatim qanday?', chat_id: askRes.body.chat_id })
      .expect(200);
    expect(sseRes.headers['content-type']).toContain('text/event-stream');
    expect(sseRes.text).toContain('event: delta');
    expect(sseRes.text).toContain('event: reply');

    // Chat history persisted
    const msgsRes = await agent.get(`/api/v1/chats/${askRes.body.chat_id}/messages`).expect(200);
    expect(msgsRes.body.items.length).toBeGreaterThanOrEqual(4);

    // 5. P1 Reports: Bank 3m, What-If, Business Plan, User CSV export
    const bankRes = await agent.get('/api/v1/reports/bank?months=3').expect(200);
    expect(bankRes.body.months).toHaveLength(3);
    expect(bankRes.body.summary.avg_monthly_profit).toBe(6_000_000);

    const whatIfRes = await agent
      .post('/api/v1/forecast/whatif')
      .send({ scenario: 'loan', amount: 34_000_000, annual_rate: 24, months: 24 })
      .expect(200);
    expect(whatIfRes.body.monthly_impact).toBe(1_797_617);
    expect(whatIfRes.body.forecast).toHaveLength(30);

    const planRes = await agent
      .post('/api/v1/advisor/plan?lang=ru')
      .send({ goal: 'Открыть вторую точку на Чорсу', investment: 34_000_000 })
      .expect(201);
    expect(planRes.body.plan.structured.investment).toBe(34_000_000);

    const exportRes = await agent.get('/api/v1/me/export.csv').expect(200);
    expect(exportRes.text.startsWith('\uFEFF')).toBe(true);
    expect(exportRes.text).toContain('id;occurred_at;kind;amount_uzs;');

    // 6. Palata (Task 21) Survey + Report + CSV
    await agent
      .post('/api/v1/palata/survey')
      .send({ question: 'why_not_registered', answer: 'tax_complexity' })
      .expect(201);

    const palataRes = await agent.get('/api/v1/palata/report?window=30').expect(200);
    expect(palataRes.body.kpi.n).toBe(812);
    expect(palataRes.body.trend_6m).toHaveLength(6);

    const palataCsv = await agent.get('/api/v1/palata/report.csv?window=30').expect(200);
    expect(palataCsv.text.startsWith('\uFEFF')).toBe(true);
    expect(palataCsv.text).toContain(';all;all;812;');
  });

  it('contains zero hardcoded API keys or cloud credentials in src/ and config/', () => {
    const files = [
      ...walkFiles(path.join(projectRoot, 'src')),
      ...walkFiles(path.join(projectRoot, 'config')),
    ];

    const secretPatterns: Array<{ name: string; regex: RegExp }> = [
      { name: 'OpenAI/Moonshot key', regex: /\bsk-[A-Za-z0-9]{20,}\b/ },
      { name: 'ElevenLabs key', regex: /\bsk_[a-f0-9]{32,}\b/ },
      { name: 'Upstash token', regex: /\bAX[A-Za-z0-9_-]{24,}\b/ },
      { name: 'Hardcoded Neon URL', regex: /postgresql:\/\/[^:\s]+:[^@\s]+@ep-[a-z0-9-]+/ },
    ];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const pattern of secretPatterns) {
        expect(
          pattern.regex.test(content),
          `Potential hardcoded secret (${pattern.name}) detected in ${file}`,
        ).toBe(false);
      }
    }
  });
});
