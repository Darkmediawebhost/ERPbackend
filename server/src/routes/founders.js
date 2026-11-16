import { Router } from 'express';
import { z } from 'zod';
import { requirePerm, requireUser } from '../auth.js';
import { recordAudit } from '../audit.js';
import { COFOUNDER_PERMISSIONS, PERMISSIONS } from '../constants.js';
import { HttpError } from '../errors.js';
import { pageQuery, parse, searchRegex, sendList, wrap } from '../http.js';
import { CoFounder, FounderContribution, FounderWithdrawal, ProfitDistribution, User } from '../models.js';
import { runTxn } from '../services/accounting.js';
import { createFounderAccount, founderParts, previewDistribution, recordContribution, recordDistribution, recordWithdrawal } from '../services/finance.js';
import { clearSettingsCache, getSettings } from '../settingsCache.js';
import { CompanySettings } from '../models.js';
import { formatBasisPoints } from '../money.js';
import { distributionBody, founderBody, movementBody } from './schemas.js';

const router = Router();
router.use(requireUser);

function presentFounder(founder, parts) {
  return {
    ...founder.toObject(),
    ownership: formatBasisPoints(founder.ownershipBps || 0),
    profitShare: formatBasisPoints(founder.profitShareBps || 0),
    finance: parts || null,
  };
}

router.get('/', requirePerm('founders.view', 'founderFinance.view'), wrap(async (req, res) => {
  const { page, limit, skip } = pageQuery(req.query);
  const filter = {};
  const regex = searchRegex(req.query.q);
  if (regex) filter.$or = [{ fullName: regex }, { email: regex }, { phone: regex }];
  if (req.query.status) filter.accountStatus = req.query.status;
  const [rows, total] = await Promise.all([
    CoFounder.find(filter).sort({ fullName: 1 }).skip(skip).limit(limit),
    CoFounder.countDocuments(filter),
  ]);
  const data = await Promise.all(rows.map(async (founder) => presentFounder(founder, await founderParts(founder._id))));
  const settings = await getSettings();
  sendList(res, data, total, page, limit, { profitSharingActive: Boolean(settings.profitSharingActive) });
}));

router.post('/', requirePerm('founders.manage'), wrap(async (req, res) => {
  const body = parse(founderBody, req.body);
  const email = body.email.toLowerCase();
  if (await CoFounder.findOne({ email })) throw new HttpError('A co-founder with this email already exists', 409);
  const founder = await CoFounder.create({
    fullName: body.fullName,
    email,
    phone: body.phone || '',
    designation: body.designation || 'Co-Founder',
    joiningDate: body.joiningDate ? new Date(`${body.joiningDate}T12:00:00+05:30`) : new Date(),
    ownershipBps: body.ownership ?? 0,
    profitShareBps: body.profitShare ?? 0,
    accessPermissions: COFOUNDER_PERMISSIONS,
    accountStatus: 'active',
  });
  await runTxn(async (session) => {
    const fresh = await CoFounder.findById(founder._id).session(session);
    await createFounderAccount(session, fresh);
  });
  const saved = await CoFounder.findById(founder._id);
  let user = await User.findOne({ email });
  if (user?.employeeId) throw new HttpError('This email belongs to an employee', 409);
  if (!user) {
    user = await User.create({
      email,
      name: saved.fullName,
      role: 'cofounder',
      permissions: COFOUNDER_PERMISSIONS,
      coFounderId: saved._id,
      status: 'active',
      passwordHash: undefined,
    });
  } else {
    user.coFounderId = saved._id;
    user.role = user.role === 'master_admin' ? user.role : 'cofounder';
    await user.save();
  }
  saved.userId = user._id;
  await saved.save();
  recordAudit(req, { action: 'create', entityType: 'coFounder', entityId: saved._id, summary: `Added co-founder ${saved.fullName}` });
  res.status(201).json({ data: presentFounder(saved, await founderParts(saved._id)) });
}));

router.get('/:id', requirePerm('founders.view', 'founderFinance.view'), wrap(async (req, res) => {
  const founder = await CoFounder.findById(req.params.id);
  if (!founder) throw new HttpError('Co-founder not found', 404);
  if (!canSeeFounder(req, founder)) throw new HttpError('You do not have permission to do that', 403);
  const [contributions, withdrawals, distributions] = await Promise.all([
    FounderContribution.find({ coFounderId: founder._id }).sort({ dateKey: -1 }),
    FounderWithdrawal.find({ coFounderId: founder._id }).sort({ dateKey: -1 }),
    ProfitDistribution.find({ voided: false, 'lines.coFounderId': founder._id }).sort({ periodStartKey: -1 }),
  ]);
  res.json({
    data: presentFounder(founder, await founderParts(founder._id)),
    contributions,
    withdrawals,
    distributions,
  });
}));

router.patch('/:id', requirePerm('founders.manage'), wrap(async (req, res) => {
  const body = parse(founderBody.partial(), req.body);
  const founder = await CoFounder.findById(req.params.id);
  if (!founder) throw new HttpError('Co-founder not found', 404);
  if (body.fullName) founder.fullName = body.fullName;
  if (body.email) founder.email = body.email.toLowerCase();
  if (body.phone !== undefined) founder.phone = body.phone;
  if (body.designation) founder.designation = body.designation;
  if (body.joiningDate) founder.joiningDate = new Date(`${body.joiningDate}T12:00:00+05:30`);
  if (body.ownership !== undefined) founder.ownershipBps = body.ownership;
  if (body.profitShare !== undefined) founder.profitShareBps = body.profitShare;
  if (body.profileImage) founder.profileImage = body.profileImage;
  if (body.accountStatus) founder.accountStatus = body.accountStatus;
  await founder.save();
  if (founder.userId) {
    const user = await User.findById(founder.userId);
    if (user) {
      user.name = founder.fullName;
      user.email = founder.email;
      user.status = founder.accountStatus === 'active' ? 'active' : 'disabled';
      await user.save();
    }
  }
  recordAudit(req, { action: 'update', entityType: 'coFounder', entityId: founder._id, summary: `Updated ${founder.fullName}` });
  res.json({ data: presentFounder(founder, await founderParts(founder._id)) });
}));

router.post('/:id/deactivate', requirePerm('founders.manage'), wrap(async (req, res) => {
  const founder = await CoFounder.findById(req.params.id);
  if (!founder) throw new HttpError('Co-founder not found', 404);
  const user = founder.userId ? await User.findById(founder.userId) : null;
  if (user?.role === 'master_admin') {
    const remaining = await User.countDocuments({ role: 'master_admin', status: 'active', _id: { $ne: user._id } });
    if (!remaining) throw new HttpError('The company needs at least one active master admin');
  }
  founder.accountStatus = 'inactive';
  await founder.save();
  if (user) {
    user.status = 'disabled';
    user.tokenVersion += 1;
    await user.save();
  }
  recordAudit(req, { action: 'deactivate', entityType: 'coFounder', entityId: founder._id, summary: `Deactivated ${founder.fullName}` });
  res.json({ data: presentFounder(founder, await founderParts(founder._id)) });
}));

router.post('/profit-sharing', requirePerm('founders.manage'), wrap(async (req, res) => {
  const body = parse(z.object({ active: z.boolean() }), req.body);
  const activeFounders = await CoFounder.find({ accountStatus: 'active' });
  if (body.active) {
    const ownership = activeFounders.reduce((sum, founder) => sum + founder.ownershipBps, 0);
    const profit = activeFounders.reduce((sum, founder) => sum + founder.profitShareBps, 0);
    if (ownership !== 10000 || profit !== 10000) {
      throw new HttpError('Active co-founders need ownership and profit shares that each total 100% before profit sharing can be turned on');
    }
  }
  await CompanySettings.updateOne({ _id: 'company' }, { $set: { profitSharingActive: body.active } });
  clearSettingsCache();
  recordAudit(req, { action: 'profit-sharing', entityType: 'settings', summary: body.active ? 'Activated profit sharing' : 'Paused profit sharing' });
  res.json({ data: { profitSharingActive: body.active } });
}));

const finance = Router();
finance.use(requireUser);

finance.get('/', requirePerm('founderFinance.view'), wrap(async (_req, res) => {
  const founders = await CoFounder.find().sort({ fullName: 1 });
  const settings = await getSettings();
  const data = await Promise.all(founders.map(async (founder) => presentFounder(founder, await founderParts(founder._id))));
  res.json({ data, profitSharingActive: Boolean(settings.profitSharingActive) });
}));

finance.post('/contributions', requirePerm('founderFinance.manage'), wrap(async (req, res) => {
  const body = parse(movementBody, req.body);
  const doc = await recordContribution({
    coFounderId: body.coFounderId,
    kind: body.kind === 'initial' ? 'initial' : 'additional',
    amountPaise: body.amount,
    dateKey: body.date,
    bankAccountId: body.bankAccountId,
    paymentMethod: body.paymentMethod,
    transactionReference: body.transactionReference,
    notes: body.notes,
    idempotencyKey: body.idempotencyKey,
  }, req.user._id);
  recordAudit(req, { action: 'contribution', entityType: 'coFounder', entityId: body.coFounderId, summary: 'Recorded a capital contribution' });
  res.status(201).json({ data: doc });
}));

finance.post('/withdrawals', requirePerm('founderFinance.manage'), wrap(async (req, res) => {
  const body = parse(movementBody, req.body);
  const doc = await recordWithdrawal({
    coFounderId: body.coFounderId,
    kind: body.kind === 'reimbursement' ? 'reimbursement' : 'withdrawal',
    amountPaise: body.amount,
    dateKey: body.date,
    bankAccountId: body.bankAccountId,
    paymentMethod: body.paymentMethod,
    transactionReference: body.transactionReference,
    notes: body.notes,
    allowCapitalOverdraw: body.allowCapitalOverdraw,
    idempotencyKey: body.idempotencyKey,
  }, req.user._id);
  recordAudit(req, { action: body.kind || 'withdrawal', entityType: 'coFounder', entityId: body.coFounderId, summary: 'Recorded a founder movement' });
  res.status(201).json({ data: doc });
}));

finance.post('/distributions/preview', requirePerm('founderFinance.view'), wrap(async (req, res) => {
  const body = parse(distributionBody.omit({ confirm: true, idempotencyKey: true, date: true }).extend({
    amount: distributionBody.shape.amount.optional(),
  }), req.body);
  const preview = await previewDistribution({
    periodStartKey: body.periodStart,
    periodEndKey: body.periodEnd,
    amountPaise: body.amount,
  });
  res.json({ data: preview });
}));

finance.post('/distributions', requirePerm('founderFinance.manage'), wrap(async (req, res) => {
  const body = parse(distributionBody, req.body);
  const doc = await recordDistribution({
    periodStartKey: body.periodStart,
    periodEndKey: body.periodEnd,
    dateKey: body.date,
    amountPaise: body.amount,
    payout: body.payout,
    bankAccountId: body.bankAccountId,
    paymentMethod: body.paymentMethod,
    notes: body.notes,
    idempotencyKey: body.idempotencyKey,
  }, req.user._id);
  recordAudit(req, { action: 'distribution', entityType: 'profitDistribution', entityId: doc._id, summary: 'Approved a profit distribution' });
  res.status(201).json({ data: doc });
}));

function canSeeFounder(req, founder) {
  if (requireView(req)) return true;
  return String(req.user.coFounderId || '') === String(founder._id);
}

function requireView(req) {
  return req.user.role === 'master_admin' || req.user.permissions?.includes('founders.view') || req.user.permissions?.includes('founderFinance.view');
}

export { finance };
export default router;
