import { Router } from 'express';
import { requirePerm, requireUser } from '../auth.js';
import { rangeFromQuery } from '../dates.js';
import { wrap } from '../http.js';
import { buildBreakdown, buildDashboard } from '../services/dashboard.js';
import { getSettings } from '../settingsCache.js';

const router = Router();

router.get('/', requireUser, requirePerm('dashboard.view'), wrap(async (req, res) => {
  const settings = await getSettings();
  const range = rangeFromQuery(req.query, settings);
  res.json({ data: await buildDashboard(req.user, range) });
}));

router.get('/breakdown', requireUser, requirePerm('dashboard.view'), wrap(async (req, res) => {
  const settings = await getSettings();
  const range = rangeFromQuery(req.query, settings);
  res.json({ data: await buildBreakdown(String(req.query.metric || ''), range) });
}));

export default router;
