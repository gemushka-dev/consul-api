import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { redis } from '../../config/redis.js';
import type { SupportedLang } from '../../types/express.d.js';
import { Errors } from '../../utils/errors.js';
import { prepareTtsText } from './tts.formatter.js';

const TTS_CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// Minimal valid MP3 frame header used only for demo/test fallback when ELEVENLABS_API_KEY is empty
const DEMO_STUB_MP3_BASE64 = Buffer.from([
  0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]).toString('base64');

export interface SttResult {
  text: string;
  lang: SupportedLang;
  provider: 'elevenlabs' | 'demo-stub';
}

function mapElevenLabsLang(code: string | undefined, fallback: SupportedLang): SupportedLang {
  if (!code) return fallback;
  const lower = code.toLowerCase();
  if (lower.startsWith('uz')) return 'uz';
  if (lower.startsWith('ru')) return 'ru';
  if (lower.startsWith('en')) return 'en';
  return fallback;
}

/**
 * Clamps playback speed to ElevenLabs' valid [0.7, 1.2] range.
 */
export function clampElevenLabsSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1.0;
  return Number(Math.min(1.2, Math.max(0.7, speed)).toFixed(2));
}

export async function transcribeAudio(params: {
  buffer: Buffer;
  mimetype: string;
  filename: string;
  lang: SupportedLang;
}): Promise<SttResult> {
  if (!env.ELEVENLABS_API_KEY) {
    if (env.APP_ENV === 'demo') {
      return {
        text: params.lang === 'ru' ? 'сегодня продал на 1,2 млн наличными' : 'bugun 1,2 mln sotdim',
        lang: params.lang,
        provider: 'demo-stub',
      };
    }
    throw Errors.serviceUnavailable(
      'elevenlabs_not_configured',
      'ELEVENLABS_API_KEY is not configured',
    );
  }

  const form = new FormData();
  const blob = new Blob([new Uint8Array(params.buffer)], { type: params.mimetype || 'audio/webm' });
  form.append('file', blob, params.filename || 'voice.webm');
  form.append('model_id', env.ELEVENLABS_STT_MODEL);

  const response = await fetch(`${env.ELEVENLABS_BASE_URL.replace(/\/$/, '')}/speech-to-text`, {
    method: 'POST',
    headers: {
      'xi-api-key': env.ELEVENLABS_API_KEY,
    },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw Errors.serviceUnavailable(
      'elevenlabs_stt_error',
      `ElevenLabs STT failed (${response.status})`,
    );
  }

  const data = (await response.json()) as { text?: string; language_code?: string };
  const detectedLang = mapElevenLabsLang(data.language_code, params.lang);

  return {
    text: (data.text ?? '').trim(),
    lang: detectedLang,
    provider: 'elevenlabs',
  };
}

export async function synthesizeSpeech(params: {
  text: string;
  speed: number;
  lang: SupportedLang;
  voiceId?: string;
}): Promise<{ audio: Buffer; cacheHit: boolean; normalizedText: string }> {
  const normalizedText = prepareTtsText(params.text, params.lang);
  const clampedSpeed = clampElevenLabsSpeed(params.speed);
  const voiceId = params.voiceId || env.ELEVENLABS_VOICE_ID;

  const hash = crypto
    .createHash('sha256')
    .update(
      `${voiceId}:${env.ELEVENLABS_TTS_MODEL}:${params.lang}:${clampedSpeed.toFixed(2)}:${normalizedText}`,
    )
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

  if (!env.ELEVENLABS_API_KEY) {
    if (env.APP_ENV === 'demo') {
      audioBuffer = Buffer.from(DEMO_STUB_MP3_BASE64, 'base64');
    } else {
      throw Errors.serviceUnavailable(
        'elevenlabs_not_configured',
        'ELEVENLABS_API_KEY is not configured',
      );
    }
  } else {
    const url = `${env.ELEVENLABS_BASE_URL.replace(/\/$/, '')}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: normalizedText,
        model_id: env.ELEVENLABS_TTS_MODEL,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          speed: clampedSpeed,
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      throw Errors.serviceUnavailable(
        'elevenlabs_tts_error',
        `ElevenLabs TTS failed (${response.status})`,
      );
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
