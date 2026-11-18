import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../../middlewares/auth.js';
import { normalizeLang } from '../../middlewares/lang.js';
import { Errors } from '../../utils/errors.js';
import { recognizeDocumentPhoto } from './vision.service.js';

const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        Errors.badRequest(
          'unsupported_image_type',
          `Only JPEG, PNG, and WebP images are supported (got ${file.mimetype})`,
          'file',
        ),
      );
    }
  },
});

export const visionRouter = Router();
visionRouter.use(requireAuth);

visionRouter.post('/', photoUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw Errors.badRequest('file_required', 'Image file field "file" is required', 'file');
    }

    const bodyLang = normalizeLang(req.body?.lang) ?? req.lang;
    const result = await recognizeDocumentPhoto({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      lang: bodyLang,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});
