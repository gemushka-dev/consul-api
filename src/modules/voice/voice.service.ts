import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { redis } from '../../config/redis.js';
import type { SupportedLang } from '../../types/express.d.js';
import { Errors } from '../../utils/errors.js';
import { prepareTtsText } from './tts.formatter.js';

const TTS_CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// Minimal valid MP3 frame header used only for demo/test fallback when VOICELAB_API_KEY is empty
const DEMO_STUB_MP3_BASE64 = Buffer.from([
  0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]).toString('base64');

export interface SttResult {
  text: string;
  lang: SupportedLang;
  provider: 'voicelab' | 'demo-stub';
}

export async function transcribeAudio(params: {
  buffer: Buffer;
  mimetype: string;
  filename: string;
  lang: SupportedLang;
}): Promise<SttResult> {
  if (!env.VOICELAB_API_KEY) {
    if (env.APP_ENV === 'demo') {
      return {
        text: params.lang === 'ru' ? 'сегодня продал на 1,2 млн наличными' : 'bugun 1,2 mln sotdim',
        lang: params.lang,
        provider: 'demo-stub',
      };
    }
    throw Errors.serviceUnavailable('voicelab_not_configured', 'VoiceLab STT API key is not configured');
  }

  const form = new FormData();
  const blob = new Blob([new Uint8Array(params.buffer)], { type: params.mimetype || 'audio/webm' });
  form.append('audio', blob, params.filename || 'voice.webm');
  form.append('lang', params.lang);

  const response = await fetch(`${env.VOICELAB_BASE_URL.replace(/\/$/, '')}/stt`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.VOICELAB_API_KEY}`,
    },
    body: form,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw Errors.serviceUnavailable('voicelab_stt_error', `VoiceLab STT failed (${response.status})`);
  }

  const data = (await response.json()) as { text?: string; lang?: string };
  const detectedLang: SupportedLang =
    data.lang === 'ru' || data.lang === 'uz' || data.lang === 'en' ? data.lang : params.lang;

  return {
    text: (data.text ?? '').trim(),
    lang: detectedLang,
    provider: 'voicelab',
  };
}

export async function synthesizeSpeech(params: {
  text: string;
  speed: number;
  lang: SupportedLang;
}): Promise<{ audio: Buffer; cacheHit: boolean; normalizedText: string }> {
  const normalizedText = prepareTtsText(params.text, params.lang);
  const hash = crypto
    .createHash('sha256')
    .update(`${params.lang}:${params.speed.toFixed(2)}:${normalizedText}`)
    .digest('hex');
  const cacheKey = `tts:${hash}`;

  const cachedBase64 = await redis.get<string>(cacheKey);
  if (cachedBase64 && typeof cachedBase64 === 'string') {
    return {
      audio: Buffer.from(cachedBase64, 'base64'),
      cacheHit: true,
      normalizedText,
    };
  }

  let audioBuffer: Buffer;

  if (!env.VOICELAB_API_KEY) {
    if (env.APP_ENV === 'demo') {
      audioBuffer = Buffer.from(DEMO_STUB_MP3_BASE64, 'base64');
    } else {
      throw Errors.serviceUnavailable(
        'voicelab_not_configured',
        'VoiceLab TTS API key is not configured',
      );
    }
  } else {
    const response = await fetch(`${env.VOICELAB_BASE_URL.replace(/\/$/, '')}/tts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.VOICELAB_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: normalizedText,
        lang: params.lang,
        speed: params.speed,
        format: 'mp3',
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw Errors.serviceUnavailable('voicelab_tts_error', `VoiceLab TTS failed (${response.status})`);
    }

    const arrayBuffer = await response.arrayBuffer();
    audioBuffer = Buffer.from(arrayBuffer);
  }

  await redis.set(cacheKey, audioBuffer.toString('base64'), { ex: TTS_CACHE_TTL_SECONDS });

  return {
    audio: audioBuffer,
    cacheHit: false,
    normalizedText,
  };
}
