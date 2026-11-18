import { Router } from 'express';
import { z } from 'zod';
import { requirePerm, requireUser } from '../auth.js';
import { notFound } from '../errors.js';
import { parse, wrap } from '../http.js';
import { WorkLink } from '../models.js';

const router = Router();
router.use(requireUser);
router.use(requirePerm('dashboard.view'));

function httpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const bodySchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(120),
  url: z.string().trim().min(1, 'Enter a link').max(2000).refine(httpUrl, 'Enter a website or Drive link starting with http:// or https://'),
});

router.get('/', wrap(async (_req, res) => {
  const data = await WorkLink.find().sort({ createdAt: -1 }).limit(300);
  res.json({ data });
}));

router.post('/', wrap(async (req, res) => {
  const body = parse(bodySchema, req.body);
  const link = await WorkLink.create({ ...body, createdBy: req.user._id });
  res.status(201).json({ data: link });
}));

router.delete('/:id', wrap(async (req, res) => {
  const link = await WorkLink.findByIdAndDelete(req.params.id);
  if (!link) throw notFound('Link not found');
  res.json({ data: { ok: true } });
}));

export default router;
