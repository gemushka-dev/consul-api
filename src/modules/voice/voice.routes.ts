import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../../middlewares/auth.js';
import { validateBody } from '../../middlewares/validate.js';
import { Errors } from '../../utils/errors.js';
import { synthesizeSpeech, transcribeAudio } from './voice.service.js';

const ALLOWED_AUDIO_MIMES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/mp4',
  'video/webm',
  'application/octet-stream',
]);

// Memory-only storage (max 2 MB, never writes audio to disk)
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_AUDIO_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(Errors.badRequest('unsupported_audio_type', `Unsupported audio MIME type: ${file.mimetype}`, 'audio'));
    }
  },
});

const ttsSchema = z.object({
  text: z.string().trim().min(1, 'Text is required').max(2000),
  speed: z.number().min(0.5).max(2.0).default(1.0),
  voice_id: z.string().trim().min(1).max(100).optional(),
});

export const voiceRouter = Router();
voiceRouter.use(requireAuth);

voiceRouter.post('/stt', audioUpload.single('audio'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw Errors.badRequest('audio_required', 'Audio file field "audio" is required', 'audio');
    }

    const result = await transcribeAudio({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      filename: req.file.originalname,
      lang: req.lang,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

voiceRouter.post('/tts', validateBody(ttsSchema), async (req, res, next) => {
  try {
    const result = await synthesizeSpeech({
      text: req.body.text,
      speed: req.body.speed,
      lang: req.lang,
      voiceId: req.body.voice_id,
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-TTS-Cache', result.cacheHit ? 'HIT' : 'MISS');
    res.send(result.audio);
  } catch (err) {
    next(err);
  }
});
