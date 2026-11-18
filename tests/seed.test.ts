import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { setupTestDb, teardownTestDb } from './helpers/testDb.js';

describe('Dilnoza Demo Seeder & POST /api/v1/auth/demo', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('resets Dilnoza demo account and returns exact benchmark figures on GET /ledger/today', async () => {
    const agent = request.agent(app);

    const demoRes = await agent.post('/api/v1/auth/demo').expect(200);
    expect(demoRes.body.demo).toBe(true);
    expect(demoRes.body.user.phone).toBe('+998901234567');

    const todayRes = await agent.get('/api/v1/ledger/today').expect(200);
    expect(todayRes.body.view.cash).toBe(12_000_000);
    expect(todayRes.body.view.naqd).toBe(4_800_000);
    expect(todayRes.body.view.karta).toBe(7_200_000);
    expect(todayRes.body.view.tax).toBe(500_000);
    expect(todayRes.body.view.obligations).toBe(6_600_000);
    expect(todayRes.body.view.reserve).toBe(1_200_000);
    expect(todayRes.body.view.free).toBe(4_200_000);
    expect(todayRes.body.view.profit_3m).toBe(6_000_000);
  });
});
