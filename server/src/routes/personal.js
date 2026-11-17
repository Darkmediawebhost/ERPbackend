import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { requirePerm, requireUser } from '../auth.js';
import { EXPENSE_CATEGORIES } from '../constants.js';
import { todayKey } from '../dates.js';
import { HttpError } from '../errors.js';
import { parse, wrap } from '../http.js';
import { CoFounder, Expense, FounderContribution, FounderWithdrawal, PersonalEntry } from '../models.js';
import { getSettings } from '../settingsCache.js';
import { recordContribution, recordExpense, recordWithdrawal, updateExpense, voidFinancial } from '../services/finance.js';
import { objectId, positiveMoney, ymd } from './schemas.js';

const PEOPLE = ['sajeel', 'shakeeb', 'ismail'];

const bodySchema = z.object({
  person: z.enum(PEOPLE),
  kind: z.enum(['income', 'expense']),
  amount: positiveMoney,
  title: z.string().trim().min(1).max(160),
  date: ymd,
  note: z.string().max(1000).optional(),
  category: z.string().trim().max(80).optional(),
  bankAccountId: z.string().optional(),
  bankDirection: z.enum(['in', 'out']).optional(),
}).superRefine((body, ctx) => {
  if (body.kind === 'expense' && !EXPENSE_CATEGORIES.includes(body.category)) {
    ctx.addIssue({ code: 'custom', message: 'Choose what this payment was for', path: ['category'] });
  }
  if (body.kind === 'income') {
    if (!objectId.safeParse(body.bankAccountId).success) {
      ctx.addIssue({ code: 'custom', message: 'Choose the bank account', path: ['bankAccountId'] });
    }
  }
});

const personal = Router();
personal.use(requireUser);

function personKey(founder) {
  const seed = String(founder?.seedKey || founder?.fullName || '').toLowerCase();
  return PEOPLE.includes(seed) ? seed : '';
}

function presentIncome(row) {
  return {
    _id: row._id,
    source: 'income',
    person: row.person,
    kind: 'income',
    amountPaise: row.amountPaise,
    title: row.title,
    dateKey: row.dateKey,
    note: row.note || '',
    category: '',
    bankAccountId: row.bankAccountId?._id || row.bankAccountId || '',
    bankName: row.bankAccountId?.accountName || '',
    bankDirection: row.bankDirection || '',
  };
}

function presentExpense(row) {
  const person = personKey(row.paidByFounderId);
  if (!person) return null;
  return {
    _id: row._id,
    source: 'expense',
    person,
    kind: 'expense',
    amountPaise: row.amountPaise,
    title: row.title,
    dateKey: row.dateKey,
    note: row.description || '',
    category: row.category || '',
  };
}

function totalsFrom(rows) {
  const blank = () => ({ incomePaise: 0, expensePaise: 0, netPaise: 0, count: 0 });
  const totals = { all: blank(), sajeel: blank(), shakeeb: blank(), ismail: blank() };
  for (const row of rows) {
    const bucket = totals[row.person];
    if (!bucket) continue;
    bucket.count += 1;
    totals.all.count += 1;
    if (row.kind === 'income') {
      bucket.incomePaise += row.amountPaise;
      totals.all.incomePaise += row.amountPaise;
    } else {
      bucket.expensePaise += row.amountPaise;
      totals.all.expensePaise += row.amountPaise;
    }
  }
  for (const key of ['all', ...PEOPLE]) {
    totals[key].netPaise = totals[key].incomePaise - totals[key].expensePaise;
  }
  return totals;
}

async function founderFor(person) {
  const founder = await CoFounder.findOne({ seedKey: person, accountStatus: 'active' });
  if (!founder) throw new HttpError('That personal account is not set up yet', 404);
  return founder;
}

async function postPocketExpense(body, userId) {
  const founder = await founderFor(body.person);
  return recordExpense({
    title: body.title,
    amountPaise: body.amount,
    category: body.category,
    dateKey: body.date,
    paidByType: 'founder',
    paidByFounderId: founder._id,
    paymentMethod: 'Own pocket',
    description: body.note || '',
    idempotencyKey: randomUUID(),
  }, userId);
}

async function listRows() {
  const [incomes, expenses] = await Promise.all([
    PersonalEntry.find({ kind: 'income' }).sort({ dateKey: -1, createdAt: -1 }).populate('bankAccountId', 'accountName'),
    Expense.find({ paidByType: 'founder', voided: false }).sort({ dateKey: -1, createdAt: -1 }).populate('paidByFounderId', 'fullName seedKey'),
  ]);
  return [
    ...incomes.map(presentIncome),
    ...expenses.map(presentExpense).filter(Boolean),
  ].sort((left, right) => String(right.dateKey).localeCompare(String(left.dateKey)));
}

personal.get('/', requirePerm('founderFinance.view'), wrap(async (req, res) => {
  let data = await listRows();
  const totals = totalsFrom(data);
  if (PEOPLE.includes(req.query.person)) data = data.filter((row) => row.person === req.query.person);
  if (req.query.kind === 'income' || req.query.kind === 'expense') data = data.filter((row) => row.kind === req.query.kind);
  res.json({ data: data.slice(0, 500), totals });
}));

personal.post('/', requirePerm('founderFinance.manage'), wrap(async (req, res) => {
  const body = parse(bodySchema, req.body);
  if (body.kind === 'income') body.bankDirection = 'out';
  if (body.kind === 'expense') {
    const expense = await postPocketExpense(body, req.user._id);
    const populated = await Expense.findById(expense._id).populate('paidByFounderId', 'fullName seedKey');
    recordAudit(req, { action: 'create', entityType: 'expense', entityId: expense._id, summary: `${body.person} paid ${body.title} from their own pocket. The company owes them the same amount.` });
    res.status(201).json({ data: presentExpense(populated) });
    return;
  }
  const entry = await createReceived(body, req.user._id);
  const populated = await PersonalEntry.findById(entry._id).populate('bankAccountId', 'accountName');
  recordAudit(req, { action: 'create', entityType: 'personalEntry', entityId: entry._id, summary: body.bankDirection === 'out' ? `Took personal money for ${body.person} from a bank` : `Added personal money for ${body.person} to a bank` });
  res.status(201).json({ data: presentIncome(populated) });
}));

personal.patch('/:id', requirePerm('founderFinance.manage'), wrap(async (req, res) => {
  const body = parse(bodySchema, req.body);
  if (body.kind === 'income') body.bankDirection = 'out';
  const source = req.body?.source === 'expense' ? 'expense' : 'income';
  if (source === 'expense') {
    const existing = await Expense.findById(req.params.id);
    if (!existing || existing.voided || existing.paidByType !== 'founder') throw new HttpError('Personal expense not found', 404);
    if (body.kind === 'income') {
      await voidPocketExpense(existing, req.user._id);
      const entry = await createReceived(body, req.user._id);
      const populated = await PersonalEntry.findById(entry._id).populate('bankAccountId', 'accountName');
      res.json({ data: presentIncome(populated) });
      return;
    }
    const founder = await founderFor(body.person);
    const doc = await updateExpense(existing._id, {
      title: body.title,
      amountPaise: body.amount,
      category: body.category,
      dateKey: body.date,
      paidByType: 'founder',
      paidByFounderId: founder._id,
      paymentMethod: 'Own pocket',
      description: body.note || '',
    }, req.user._id);
    const populated = await Expense.findById(doc._id).populate('paidByFounderId', 'fullName seedKey');
    recordAudit(req, { action: 'update', entityType: 'expense', entityId: doc._id, summary: `Updated pocket payment for ${body.person}` });
    res.json({ data: presentExpense(populated) });
    return;
  }
  const entry = await PersonalEntry.findById(req.params.id);
  if (!entry) throw new HttpError('Personal entry not found', 404);
  if (body.kind === 'expense') {
    await voidMovement(entry, req.user._id);
    const expense = await postPocketExpense(body, req.user._id);
    await entry.deleteOne();
    const populated = await Expense.findById(expense._id).populate('paidByFounderId', 'fullName seedKey');
    res.json({ data: presentExpense(populated) });
    return;
  }
  await voidMovement(entry, req.user._id);
  const movement = await moveBank(body, await founderFor(body.person), req.user._id);
  entry.person = body.person;
  entry.kind = 'income';
  entry.amountPaise = body.amount;
  entry.title = body.title;
  entry.dateKey = body.date;
  entry.note = body.note || '';
  entry.bankAccountId = body.bankAccountId;
  entry.bankDirection = body.bankDirection;
  entry.movementType = movement.type;
  entry.movementId = movement.doc._id;
  await entry.save();
  const populated = await PersonalEntry.findById(entry._id).populate('bankAccountId', 'accountName');
  recordAudit(req, { action: 'update', entityType: 'personalEntry', entityId: entry._id, summary: `Updated personal money for ${body.person}` });
  res.json({ data: presentIncome(populated) });
}));

personal.delete('/:id', requirePerm('founderFinance.manage'), wrap(async (req, res) => {
  if (req.query.source === 'expense') {
    const expense = await Expense.findById(req.params.id);
    if (!expense || expense.voided || expense.paidByType !== 'founder') throw new HttpError('Personal expense not found', 404);
    await voidPocketExpense(expense, req.user._id);
    recordAudit(req, { action: 'delete', entityType: 'expense', entityId: expense._id, summary: 'Removed a pocket payment. The company no longer owes this amount.' });
    res.json({ data: { ok: true } });
    return;
  }
  const entry = await PersonalEntry.findById(req.params.id);
  if (!entry) throw new HttpError('Personal entry not found', 404);
  await voidMovement(entry, req.user._id);
  await entry.deleteOne();
  recordAudit(req, { action: 'delete', entityType: 'personalEntry', entityId: entry._id, summary: `Deleted personal income for ${entry.person}` });
  res.json({ data: { ok: true } });
}));

async function createReceived(body, userId) {
  const founder = await founderFor(body.person);
  const movement = await moveBank(body, founder, userId);
  return PersonalEntry.create({
    person: body.person,
    kind: 'income',
    amountPaise: body.amount,
    title: body.title,
    dateKey: body.date,
    note: body.note || '',
    bankAccountId: body.bankAccountId,
    bankDirection: body.bankDirection,
    movementType: movement.type,
    movementId: movement.doc._id,
    createdBy: userId,
  });
}

async function moveBank(body, founder, userId) {
  if (body.bankDirection === 'out') {
    const doc = await recordWithdrawal({
      coFounderId: founder._id,
      kind: 'withdrawal',
      amountPaise: body.amount,
      dateKey: body.date,
      bankAccountId: body.bankAccountId,
      paymentMethod: 'cash',
      notes: body.title,
      allowCapitalOverdraw: true,
      idempotencyKey: randomUUID(),
    }, userId);
    return { type: 'withdrawal', doc };
  }
  const doc = await recordContribution({
    coFounderId: founder._id,
    kind: 'additional',
    amountPaise: body.amount,
    dateKey: body.date,
    bankAccountId: body.bankAccountId,
    paymentMethod: 'cash',
    notes: body.title,
    idempotencyKey: randomUUID(),
  }, userId);
  return { type: 'contribution', doc };
}

async function voidMovement(entry, userId) {
  if (!entry?.movementId) return;
  const Model = entry.movementType === 'withdrawal' ? FounderWithdrawal : FounderContribution;
  const doc = await Model.findById(entry.movementId);
  if (!doc || doc.voided) return;
  if (!doc.journalEntryId) {
    doc.voided = true;
    await doc.save();
    return;
  }
  const today = todayKey((await getSettings()).timezone);
  await voidFinancial(doc.journalEntryId, userId, 'Removed personal bank movement', today);
}

async function voidPocketExpense(expense, userId) {
  if (!expense.journalEntryId) {
    expense.voided = true;
    await expense.save();
    return;
  }
  const today = todayKey((await getSettings()).timezone);
  await voidFinancial(expense.journalEntryId, userId, 'Removed pocket payment', today);
}

export default personal;
