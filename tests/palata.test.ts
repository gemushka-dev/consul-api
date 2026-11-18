import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import {
  computeSlicesWithKAnonymity,
  type MerchantAggregateInput,
} from '../src/modules/palata/palata.aggregator.js';
import { seedPalataData } from '../src/scripts/seed-palata.js';
import { setupTestDb, teardownTestDb } from './helpers/testDb.js';

describe('Palata (Task 21) k-Anonymity Aggregator & CSV Export', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('strictly suppresses any group with n < 5 (k-anonymity)', () => {
    const merchants: MerchantAggregateInput[] = [
      // 5 merchants in dried_fruit/chorsu -> INCLUDED
      ...Array.from({ length: 5 }, (_, i) => ({
        userId: `u-ok-${i}`,
        sector: 'dried_fruit',
        market: 'chorsu',
        status: 'yatt',
        totalSales: 50_000_000,
        fiscalSales: 25_000_000,
        cashSales: 25_000_000,
        nasiyaSales: 2_000_000,
        totalCosts: 40_000_000,
        formalizedInWindow: i === 0,
      })),
      // Only 4 merchants in services/oloy -> MUST BE SUPPRESSED
      ...Array.from({ length: 4 }, (_, i) => ({
        userId: `u-small-${i}`,
        sector: 'services',
        market: 'oloy',
        status: 'none',
        totalSales: 20_000_000,
        fiscalSales: 2_000_000,
        cashSales: 18_000_000,
        nasiyaSales: 0,
        totalCosts: 14_000_000,
        formalizedInWindow: false,
      })),
    ];

    const slices = computeSlicesWithKAnonymity(merchants, 30);
    expect(slices.every((s) => s.n >= 5)).toBe(true);
    expect(slices.find((s) => s.cut === 'all')?.n).toBe(9);
    expect(slices.find((s) => s.cut === 'sector' && s.cutKey === 'dried_fruit')?.n).toBe(5);
    expect(slices.find((s) => s.cut === 'sector' && s.cutKey === 'services')).toBeUndefined();
    expect(slices.find((s) => s.cut === 'market' && s.cutKey === 'oloy')).toBeUndefined();
  });

  it('seeds 812 entrepreneurs and serves GET /palata/report and UTF-8 BOM CSV', async () => {
    const seeded = await seedPalataData(812);
    expect(seeded.entrepreneurs).toBe(812);
    expect(seeded.snapshotsWritten).toBeGreaterThan(20);

    const reportRes = await request(app).get('/api/v1/palata/report?window=30').expect(200);
    expect(reportRes.body.window_days).toBe(30);
    expect(reportRes.body.k_anonymity_min).toBe(5);
    expect(reportRes.body.kpi.n).toBe(812);
    expect(reportRes.body.trend_6m).toHaveLength(6);
    expect(reportRes.body.by_sector.every((s: { n: number }) => s.n >= 5)).toBe(true);
    expect(reportRes.body.by_market.every((m: { n: number }) => m.n >= 5)).toBe(true);
    expect(reportRes.body.survey.total_responses).toBe(240);

    const csvRes = await request(app).get('/api/v1/palata/report.csv?window=30').expect(200);
    expect(csvRes.headers['content-type']).toContain('text/csv');
    expect(csvRes.text.startsWith('\uFEFF')).toBe(true);
    expect(csvRes.text).toContain('period_end;window_days;cut;cut_key;n;');
  });
});
