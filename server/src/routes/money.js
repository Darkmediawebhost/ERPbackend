import { Router } from 'express';
import { z } from 'zod';
import { requirePerm, requireUser } from '../auth.js';
import { recordAudit } from '../audit.js';
import { HttpError } from '../errors.js';
import { pageQuery, parse, searchRegex, sendList, wrap } from '../http.js';
import { BankAccount, Expense, Income, Transaction } from '../models.js';
import { presentBank } from '../present.js';
import { accountStatement } from '../services/reports.js';
import {
  openBankAccount,
  processRecurringExpenses,
  reconcileAccount,
  recordExpense,
  recordIncome,
  updateExpense,
  updateIncome,
  transferFunds,
  voidFinancial,
} from '../services/finance.js';
import { StoredFile } from '../models.js';
import { bankBody, expenseBody, incomeBody, positiveMoney, ymd, idempotencyKey, objectId } from './schemas.js';
import { todayKey } from '../dates.js';
import { getSettings } from '../settingsCache.js';

const income = Router();
const expenses = Router();
const banks = Router();
income.use(requireUser);
expenses.use(requireUser);
banks.use(requireUser);

income.get('/', requirePerm('income.view'), wrap(async (req, res) => {
  const { page, limit, skip } = pageQuery(req.query);
  const filter = { voided: false };
  if (req.query.category) filter.category = req.query.category;
  if (req.query.clientId) filter.clientId = req.query.clientId;
  if (req.query.from || req.query.to) {
    filter.dateKey = {};
    if (req.query.from) filter.dateKey.$gte = req.query.from;
    if (req.query.to) filter.dateKey.$lte = req.query.to;
  }
  const regex = searchRegex(req.query.q);
  if (regex) filter.title = regex;
  const [data, total, sum] = await Promise.all([
    Income.find(filter).sort({ dateKey: -1 }).skip(skip).limit(limit).populate('clientId', 'name').populate('bankAccountId', 'accountName'),
    Income.countDocuments(filter),
    Income.aggregate([{ $match: filter }, { $group: { _id: null, amount: { $sum: '$amountPaise' } } }]),
  ]);
  sendList(res, data, total, page, limit, { amountPaise: sum[0]?.amount || 0 });
}));

income.post('/', requirePerm('income.manage'), wrap(async (req, res) => {
  const body = parse(incomeBody, req.body);
  const doc = await recordIncome({
    title: body.title,
    amountPaise: body.amount,
    dateKey: body.date,
    time: body.time,
    category: body.category,
    clientId: body.clientId,
    projectId: body.projectId,
    bankAccountId: body.bankAccountId,
    paymentMethod: body.paymentMethod,
    transactionReference: body.transactionReference,
    description: body.description || '',
    attachment: await fileMeta(body.attachmentKey),
    idempotencyKey: body.idempotencyKey,
  }, req.user._id);
  recordAudit(req, { action: 'create', entityType: 'income', entityId: doc._id, summary: `Recorded income ${doc.title}` });
  res.status(201).json({ data: doc });
}));

income.patch('/:id', requirePerm('income.manage'), wrap(async (req, res) => {
  const body = parse(incomeBody.omit({ idempotencyKey: true }), req.body);
  const doc = await updateIncome(req.params.id, {
    title: body.title,
    amountPaise: body.amount,
    dateKey: body.date,
    time: body.time,
    category: body.category,
    clientId: body.clientId,
    projectId: body.projectId,
    bankAccountId: body.bankAccountId,
    paymentMethod: body.paymentMethod,
    transactionReference: body.transactionReference,
    description: body.description || '',
  }, req.user._id);
  recordAudit(req, { action: 'update', entityType: 'income', entityId: doc._id, summary: `Edited income ${doc.title}` });
  res.json({ data: doc });
}));

income.post('/:id/void', requirePerm('income.manage', 'ledger.post'), wrap(async (req, res) => {
  const row = await Income.findById(req.params.id);
  if (!row || row.voided) throw new HttpError('Income record not found', 404);
  const today = todayKey((await getSettings()).timezone);
  await voidFinancial(row.journalEntryId, req.user._id, req.body?.reason || 'Voided income', today);
  res.json({ data: { ok: true } });
}));

expenses.get('/', requirePerm('expenses.view'), wrap(async (req, res) => {
  const { page, limit, skip } = pageQuery(req.query);
  const filter = { voided: false };
  if (req.query.category) filter.category = req.query.category;
  if (req.query.year) filter.dateKey = { $regex: `^${req.query.year}` };
  if (req.query.month) filter.dateKey = { $regex: `^${req.query.month}` };
  if (req.query.from || req.query.to) {
    filter.dateKey = {};
    if (req.query.from) filter.dateKey.$gte = req.query.from;
    if (req.query.to) filter.dateKey.$lte = req.query.to;
  }
  const regex = searchRegex(req.query.q);
  if (regex) filter.title = regex;
  const [data, total, sum] = await Promise.all([
    Expense.find(filter).sort({ dateKey: -1 }).skip(skip).limit(limit).populate('bankAccountId', 'accountName').populate('paidByFounderId', 'fullName'),
    Expense.countDocuments(filter),
    Expense.aggregate([{ $match: filter }, { $group: { _id: null, amount: { $sum: '$amountPaise' } } }]),
  ]);
  sendList(res, data, total, page, limit, { amountPaise: sum[0]?.amount || 0 });
}));

expenses.post('/', requirePerm('expenses.manage'), wrap(async (req, res) => {
  const body = parse(expenseBody, req.body);
  if (body.paidByType === 'founder' && !body.paidByFounderId) throw new HttpError('Choose the co-founder who paid this expense');
  const doc = await recordExpense({
    title: body.title,
    amountPaise: body.amount,
    category: body.category,
    dateKey: body.date,
    time: body.time,
    paidByType: body.paidByType,
    paidByFounderId: body.paidByFounderId,
    bankAccountId: body.bankAccountId,
    paymentMethod: body.paymentMethod,
    description: body.description || '',
    receipt: await fileMeta(body.receiptKey),
    isRecurring: body.isRecurring,
    idempotencyKey: body.idempotencyKey,
  }, req.user._id);
  recordAudit(req, { action: 'create', entityType: 'expense', entityId: doc._id, summary: `Recorded expense ${doc.title}` });
  res.status(201).json({ data: doc });
}));

expenses.post('/process-recurring', requirePerm('expenses.manage'), wrap(async (req, res) => {
  const created = await processRecurringExpenses(req.user._id);
  res.json({ data: { created: created.length } });
}));

expenses.patch('/:id', requirePerm('expenses.manage'), wrap(async (req, res) => {
  const body = parse(expenseBody.omit({ idempotencyKey: true }), req.body);
  if (body.paidByType === 'founder' && !body.paidByFounderId) throw new HttpError('Choose the co-founder who paid this expense');
  const doc = await updateExpense(req.params.id, {
    title: body.title,
    amountPaise: body.amount,
    category: body.category,
    dateKey: body.date,
    time: body.time,
    paidByType: body.paidByType,
    paidByFounderId: body.paidByFounderId,
    bankAccountId: body.bankAccountId,
    paymentMethod: body.paymentMethod,
    description: body.description || '',
    isRecurring: body.isRecurring,
  }, req.user._id);
  recordAudit(req, { action: 'update', entityType: 'expense', entityId: doc._id, summary: `Edited expense ${doc.title}` });
  res.json({ data: doc });
}));

expenses.post('/:id/void', requirePerm('expenses.manage', 'ledger.post'), wrap(async (req, res) => {
  const row = await Expense.findById(req.params.id);
  if (!row || row.voided) throw new HttpError('Expense record not found', 404);
  const today = todayKey((await getSettings()).timezone);
  await voidFinancial(row.journalEntryId, req.user._id, req.body?.reason || 'Voided expense', today);
  res.json({ data: { ok: true } });
}));

banks.get('/', requirePerm('banks.view'), wrap(async (_req, res) => {
  const rows = await BankAccount.find().sort({ accountName: 1 });
  const data = rows.map((bank) => presentBank(bank));
  const totalPaise = rows.filter((bank) => bank.status === 'active').reduce((sum, bank) => sum + bank.currentBalancePaise, 0);
  res.json({ data, meta: { totalPaise } });
}));

banks.post('/', requirePerm('banks.manage'), wrap(async (req, res) => {
  const body = parse(bankBody, req.body);
  const settings = await getSettings();
  const bank = await openBankAccount({
    accountName: body.accountName,
    bankName: body.bankName || '',
    accountHolder: body.accountHolder || '',
    accountNumber: body.accountNumber || '',
    accountType: body.accountType,
    openingBalancePaise: body.openingBalance || 0,
    openingDate: body.openingDate || todayKey(settings.timezone),
    allowOverdraft: Boolean(body.allowOverdraft),
  }, req.user._id);
  recordAudit(req, { action: 'create', entityType: 'bankAccount', entityId: bank._id, summary: `Opened account ${bank.accountName}` });
  res.status(201).json({ data: presentBank(bank) });
}));

banks.get('/:id', requirePerm('banks.view'), wrap(async (req, res) => {
  const bank = await BankAccount.findById(req.params.id);
  if (!bank) throw new HttpError('Account not found', 404);
  res.json({ data: presentBank(bank) });
}));

banks.patch('/:id', requirePerm('banks.manage'), wrap(async (req, res) => {
  const body = parse(bankBody.partial().omit({ openingBalance: true, openingDate: true }), req.body);
  const bank = await BankAccount.findById(req.params.id);
  if (!bank) throw new HttpError('Account not found', 404);
  if (body.accountName) bank.accountName = body.accountName;
  if (body.bankName !== undefined) bank.bankName = body.bankName;
  if (body.accountHolder !== undefined) bank.accountHolder = body.accountHolder;
  if (body.accountNumber) bank.accountNumber = body.accountNumber;
  if (body.allowOverdraft !== undefined) bank.allowOverdraft = body.allowOverdraft;
  if (body.status) {
    if (bank.isSystem && body.status === 'inactive') throw new HttpError('The company cash account stays active');
    bank.status = body.status;
  }
  await bank.save();
  res.json({ data: presentBank(bank) });
}));

banks.get('/:id/statement', requirePerm('banks.view'), wrap(async (req, res) => {
  const bank = await BankAccount.findById(req.params.id);
  if (!bank) throw new HttpError('Account not found', 404);
  const settings = await getSettings();
  const from = req.query.from || `${todayKey(settings.timezone).slice(0, 7)}-01`;
  const to = req.query.to || todayKey(settings.timezone);
  const statement = await accountStatement(bank.ledgerAccountId, from, to);
  const transactions = await Transaction.find({ bankAccountId: bank._id, dateKey: { $gte: from, $lte: to } }).sort({ dateKey: 1 });
  res.json({ data: { bank: presentBank(bank), statement, transactions } });
}));

banks.post('/:id/reconcile', requirePerm('banks.manage'), wrap(async (req, res) => {
  const body = parse(z.object({
    asOf: ymd,
    statementBalance: z.union([z.string(), z.number()]),
    notes: z.string().max(1000).optional(),
  }), req.body);
  const { rupeesToPaise } = await import('../money.js');
  const bank = await reconcileAccount(req.params.id, {
    asOf: body.asOf,
    statementBalancePaise: rupeesToPaise(body.statementBalance),
    notes: body.notes,
  }, req.user._id);
  res.json({ data: presentBank(bank) });
}));

banks.post('/:id/reveal', requirePerm('users.manage'), wrap(async (req, res) => {
  const bank = await BankAccount.findById(req.params.id);
  if (!bank) throw new HttpError('Account not found', 404);
  recordAudit(req, { action: 'reveal', entityType: 'bankAccount', entityId: bank._id, summary: `Revealed account number for ${bank.accountName}` });
  res.json({ data: presentBank(bank, { reveal: true }) });
}));

banks.post('/transfer', requirePerm('banks.manage'), wrap(async (req, res) => {
  const body = parse(z.object({
    fromAccountId: objectId,
    toAccountId: objectId,
    amount: positiveMoney,
    date: ymd,
    memo: z.string().max(200).optional(),
    idempotencyKey,
  }), req.body);
  const result = await transferFunds({
    fromAccountId: body.fromAccountId,
    toAccountId: body.toAccountId,
    amountPaise: body.amount,
    dateKey: body.date,
    memo: body.memo,
    idempotencyKey: body.idempotencyKey,
  }, req.user._id);
  res.status(201).json({ data: result.entry || result });
}));

async function fileMeta(key) {
  if (!key) return undefined;
  const file = await StoredFile.findOne({ key });
  if (!file) return undefined;
  return { key: file.key, name: file.originalName, mime: file.mime, size: file.size };
}

export { banks, expenses, income };
