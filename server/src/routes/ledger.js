import { Router } from 'express';
import { requirePerm, requireUser } from '../auth.js';
import { recordAudit } from '../audit.js';
import { todayKey } from '../dates.js';
import { HttpError } from '../errors.js';
import { parse, wrap } from '../http.js';
import { JournalEntry, JournalLine, LedgerAccount } from '../models.js';
import { accountStatement, integrityCheck } from '../services/reports.js';
import { postManualJournal, voidFinancial } from '../services/finance.js';
import { getSettings } from '../settingsCache.js';
import { manualJournalBody, ymd } from './schemas.js';
import { z } from 'zod';

const router = Router();
router.use(requireUser);

router.get('/', requirePerm('ledger.view'), wrap(async (req, res) => {
  const filter = {};
  if (req.query.type) filter.type = req.query.type;
  if (req.query.q) filter.name = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const data = await LedgerAccount.find(filter).sort({ code: 1 });
  res.json({ data });
}));

router.get('/integrity', requirePerm('ledger.view'), wrap(async (_req, res) => {
  res.json({ data: await integrityCheck() });
}));

router.post('/journals', requirePerm('ledger.post'), wrap(async (req, res) => {
  const body = parse(manualJournalBody, req.body);
  const result = await postManualJournal({
    dateKey: body.date,
    memo: body.memo,
    idempotencyKey: body.idempotencyKey,
    lines: body.lines.map((line) => ({
      accountId: line.accountId,
      debitPaise: line.debit || 0,
      creditPaise: line.credit || 0,
      memo: line.memo,
    })),
  }, req.user._id);
  recordAudit(req, { action: 'journal', entityType: 'journalEntry', entityId: result.entry?._id, summary: body.memo });
  res.status(201).json({ data: result.entry || result });
}));

router.get('/journals/:id', requirePerm('ledger.view'), wrap(async (req, res) => {
  const entry = await JournalEntry.findById(req.params.id);
  if (!entry) throw new HttpError('Journal entry not found', 404);
  const lines = await JournalLine.find({ journalEntryId: entry._id }).populate('ledgerAccountId', 'code name');
  res.json({ data: entry, lines });
}));

router.post('/journals/:id/reverse', requirePerm('ledger.post'), wrap(async (req, res) => {
  const body = parse(z.object({ reason: z.string().trim().min(3).max(400), date: ymd.optional() }), req.body);
  const settings = await getSettings();
  const result = await voidFinancial(req.params.id, req.user._id, body.reason, body.date || todayKey(settings.timezone));
  recordAudit(req, { action: 'reverse', entityType: 'journalEntry', entityId: req.params.id, summary: body.reason });
  res.json({ data: result.entry });
}));

router.get('/:id', requirePerm('ledger.view'), wrap(async (req, res) => {
  const account = await LedgerAccount.findById(req.params.id);
  if (!account) throw new HttpError('Ledger account not found', 404);
  const settings = await getSettings();
  const today = todayKey(settings.timezone);
  const from = req.query.from || `${today.slice(0, 4)}-01-01`;
  const to = req.query.to || today;
  const statement = await accountStatement(account._id, from, to);
  res.json({ data: statement });
}));

export default router;
