import { describe, expect, it } from 'vitest';
import { redis } from '../src/config/redis.js';
import { numberToWords, prepareTtsText } from '../src/modules/voice/tts.formatter.js';
import { synthesizeSpeech } from '../src/modules/voice/voice.service.js';

describe('VoiceLab TTS Formatter & Upstash Redis Caching', () => {
  it('strips markdown and converts monetary figures into UZ and RU words', () => {
    expect(numberToWords(4_200_000, 'uz')).toBe("to'rt million ikki yuz ming");
    expect(numberToWords(4_200_000, 'ru')).toBe('четыре миллиона двести тысяч');

    const cleanedUz = prepareTtsText("**Bo'sh pul:** 4 200 000 so'm (24%)", 'uz');
    expect(cleanedUz).not.toContain('**');
    expect(cleanedUz).toContain("to'rt million ikki yuz ming");
    expect(cleanedUz).toContain('24 foiz');

    const cleanedRu = prepareTtsText('**Свободно:** 1 200 000 сум (15%)', 'ru');
    expect(cleanedRu).not.toContain('**');
    expect(cleanedRu).toContain('один миллион двести тысяч');
    expect(cleanedRu).toContain('15 процентов');
  });

  it('caches synthesized TTS audio in Redis for 24h (MISS then HIT)', async () => {
    redis.clearForTests?.();

    const first = await synthesizeSpeech({
      text: '**4 200 000** сум можно потратить',
      speed: 1.0,
      lang: 'ru',
    });
    expect(first.cacheHit).toBe(false);
    expect(first.audio.length).toBeGreaterThan(0);

    const second = await synthesizeSpeech({
      text: '4 200 000 сум можно потратить',
      speed: 1.0,
      lang: 'ru',
    });
    expect(second.cacheHit).toBe(true);
    expect(second.audio.equals(first.audio)).toBe(true);
  });
});
