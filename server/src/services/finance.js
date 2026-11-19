import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {
  BankAccount,
  Client,
  ClientPayment,
  CoFounder,
  Expense,
  FounderContribution,
  FounderWithdrawal,
  Income,
  Invoice,
  InvoiceItem,
  JournalEntry,
  JournalLine,
  LedgerAccount,
  ProfitDistribution,
  SalaryRecord,
} from '../models.js';
import { EXPENSE_ACCOUNT_CODES, INCOME_ACCOUNT_CODES, RECURRING_PAYMENT_TYPES } from '../constants.js';
import { addMonths, todayKey } from '../dates.js';
import { HttpError } from '../errors.js';
import {
  capitalFromParts,
  formatQuantity,
  lineAmountPaise,
  percentageOf,
  quantityMilli,
  splitByBasisPoints,
} from '../money.js';
import { getSettings } from '../settingsCache.js';
import { accountBalance, accountByCode, activeBank, postEntry, reverseEntry, runTxn } from './accounting.js';

const objectId = (value) => new mongoose.Types.ObjectId(String(value));

function aggregate(model, pipeline, session) {
  const query = model.aggregate(pipeline);
  if (session) query.session(session);
  return query;
}

function withSession(query, session) {
  return session ? query.session(session) : query;
}

async function existingIdempotent(model, key) {
  if (!key) return null;
  return model.findOne({ idempotencyKey: key });
}

function paymentStatus(amountPaise, receivedPaise, dueDate, today) {
  if (receivedPaise >= amountPaise) return 'paid';
  if (dueDate && dueDate < today) return 'overdue';
  if (receivedPaise > 0) return 'partial';
  return 'pending';
}

function invoiceStatus(invoice, today) {
  if (invoice.status === 'draft' || invoice.status === 'cancelled') return invoice.status;
  if (invoice.amountPaidPaise >= invoice.totalPaise && invoice.totalPaise > 0) return 'paid';
  if (invoice.dueDate && invoice.dueDate < today) return 'overdue';
  if (invoice.amountPaidPaise > 0) return 'partial';
  return 'sent';
}

export async function refreshOverdues() {
  const today = todayKey((await getSettings()).timezone);
  await ClientPayment.updateMany(
    { voided: false, dueDate: { $regex: /^\d{4}-\d{2}-\d{2}$/, $lt: today }, status: { $in: ['pending', 'partial'] } },
    { $set: { status: 'overdue' } },
  );
  await Invoice.updateMany(
    { status: { $in: ['sent', 'partial'] }, dueDate: { $lt: today }, $expr: { $lt: ['$amountPaidPaise', '$totalPaise'] } },
    { $set: { status: 'overdue' } },
  );
}

async function categoryAccount(session, kind, category) {
  const code = (kind === 'income' ? INCOME_ACCOUNT_CODES : EXPENSE_ACCOUNT_CODES)[category];
  if (!code) throw new HttpError('Unknown category');
  return accountByCode(session, code);
}

async function accountForMethod(session, method, bankAccountId) {
  if (method === 'bank_transfer') {
    if (!bankAccountId) throw new HttpError('Choose the bank for this transfer');
    const bank = await activeBank(session, bankAccountId);
    if (bank.accountType === 'cash') throw new HttpError('A bank transfer uses a bank account. Cash uses Company Cash.');
    return bank;
  }
  if (method && method !== 'cash') throw new HttpError('Use cash or bank transfer');
  const cash = await BankAccount.findOne({ isSystem: true, accountType: 'cash', status: 'active' }).session(session);
  if (!cash) throw new HttpError('Company cash account is not available');
  return cash;
}

function methodName(method) {
  return method === 'bank_transfer' ? 'bank_transfer' : 'cash';
}

export async function createReceivableAccount(session, client) {
  const counter = await mongoose.model('Counter').findOneAndUpdate(
    { _id: 'ar' },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session },
  );
  const [account] = await LedgerAccount.create(
    [
      {
        code: `AR${String(counter.seq).padStart(4, '0')}`,
        name: `Receivable · ${client.name}`,
        type: 'asset',
        subtype: 'receivable',
        normalBalance: 'debit',
        ownerType: 'client',
        ownerId: client._id,
        isSystem: false,
      },
    ],
    { session },
  );
  client.ledgerAccountId = account._id;
  await client.save({ session });
  return account;
}

export async function createFounderAccount(session, founder) {
  const counter = await mongoose.model('Counter').findOneAndUpdate(
    { _id: 'cap' },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session },
  );
  const [account] = await LedgerAccount.create(
    [
      {
        code: `CAP${String(counter.seq).padStart(4, '0')}`,
        name: `Capital · ${founder.fullName}`,
        type: 'equity',
        subtype: 'capital',
        normalBalance: 'credit',
        ownerType: 'founder',
        ownerId: founder._id,
        isSystem: false,
      },
    ],
    { session },
  );
  founder.ledgerAccountId = account._id;
  await founder.save({ session });
  return account;
}

export async function founderParts(founderId, session) {
  const id = objectId(founderId);
  const [contributions, movements, expenses, distributionRows, account] = await Promise.all([
    aggregate(FounderContribution, [{ $match: { coFounderId: id, voided: false } }, { $group: { _id: '$kind', total: { $sum: '$amountPaise' } } }], session),
    aggregate(FounderWithdrawal, [{ $match: { coFounderId: id, voided: false } }, { $group: { _id: '$kind', total: { $sum: '$amountPaise' } } }], session),
    aggregate(Expense, [{ $match: { paidByFounderId: id, paidByType: 'founder', voided: false } }, { $group: { _id: null, total: { $sum: '$amountPaise' } } }], session),
    aggregate(
      ProfitDistribution,
      [
        { $match: { voided: false } },
        { $unwind: '$lines' },
        { $match: { 'lines.coFounderId': id } },
        { $group: { _id: '$kind', total: { $sum: '$lines.amountPaise' } } },
      ],
      session,
    ),
    withSession(LedgerAccount.findOne({ ownerType: 'founder', ownerId: id }), session),
  ]);
  const pick = (rows, key) => rows.find((row) => row._id === key)?.total || 0;
  const parts = {
    investedPaise: contributions.reduce((sum, row) => sum + row.total, 0),
    initialPaise: pick(contributions, 'initial'),
    additionalPaise: pick(contributions, 'additional'),
    withdrawalsPaise: pick(movements, 'withdrawal'),
    reimbursementsPaise: pick(movements, 'reimbursement'),
    personalExpensesPaise: expenses[0]?.total || 0,
    profitPaise: pick(distributionRows, 'profit'),
    lossPaise: pick(distributionRows, 'loss'),
  };
  parts.computedCapitalPaise = capitalFromParts(parts);
  parts.reimbursementDuePaise = Math.max(0, parts.personalExpensesPaise - parts.reimbursementsPaise);
  parts.ledgerBalancePaise = account ? await accountBalance(session, account, undefined) : 0;
  parts.reconciled = parts.ledgerBalancePaise === parts.computedCapitalPaise;
  return parts;
}

async function profitBetween(from, to, session) {
  const rows = await aggregate(
    JournalLine,
    [
      { $lookup: { from: 'journalentries', localField: 'journalEntryId', foreignField: '_id', as: 'entry' } },
      { $unwind: '$entry' },
      { $match: { 'entry.status': 'posted', 'entry.dateKey': { $gte: from, $lte: to } } },
      { $lookup: { from: 'ledgeraccounts', localField: 'ledgerAccountId', foreignField: '_id', as: 'account' } },
      { $unwind: '$account' },
      { $match: { 'account.type': { $in: ['income', 'expense'] } } },
      { $group: { _id: '$account.type', debit: { $sum: '$debitPaise' }, credit: { $sum: '$creditPaise' } } },
    ],
    session,
  );
  const income = rows.find((row) => row._id === 'income') || { debit: 0, credit: 0 };
  const expense = rows.find((row) => row._id === 'expense') || { debit: 0, credit: 0 };
  const incomePaise = income.credit - income.debit;
  const expensePaise = expense.debit - expense.credit;
  return { incomePaise, expensePaise, netPaise: incomePaise - expensePaise };
}

export async function previewDistribution({ periodStartKey, periodEndKey, amountPaise }) {
  const founders = await CoFounder.find({ accountStatus: 'active' }).sort({ fullName: 1 });
  if (!founders.length) throw new HttpError('Add an active co-founder before distributing profit');
  const shareTotal = founders.reduce((sum, founder) => sum + founder.profitShareBps, 0);
  if (shareTotal !== 10000) {
    throw new HttpError('Active co-founder profit shares must total 100% before a distribution can be prepared');
  }
  const settings = await getSettings();
  if (!settings.profitSharingActive) {
    throw new HttpError('Turn on profit sharing in Co-Founder Management after the shares are approved');
  }
  const overlap = await ProfitDistribution.findOne({
    voided: false,
    periodStartKey: { $lte: periodEndKey },
    periodEndKey: { $gte: periodStartKey },
    $nor: [{ periodStartKey, periodEndKey }],
  });
  if (overlap) {
    throw new HttpError('That date range overlaps a distribution that was already recorded');
  }
  const period = await profitBetween(periodStartKey, periodEndKey);
  const samePeriod = await ProfitDistribution.find({ voided: false, periodStartKey, periodEndKey });
  const alreadySigned = samePeriod.reduce((sum, row) => sum + row.signedPaise, 0);
  const availablePaise = period.netPaise - alreadySigned;
  if (availablePaise === 0) throw new HttpError('There is no undistributed profit or loss in that period');
  let distributing = availablePaise;
  if (amountPaise !== undefined && amountPaise !== null) {
    if (!Number.isInteger(amountPaise) || amountPaise === 0) throw new HttpError('Enter a distribution amount');
    if (Math.sign(amountPaise) !== Math.sign(availablePaise) || Math.abs(amountPaise) > Math.abs(availablePaise)) {
      throw new HttpError('The amount must stay within the undistributed profit or loss for that period');
    }
    distributing = amountPaise;
  }
  const lines = splitByBasisPoints(
    distributing,
    founders.map((founder) => ({ id: founder._id, name: founder.fullName, bps: founder.profitShareBps })),
  ).map((line) => ({
    coFounderId: line.id,
    name: line.name,
    bps: line.bps,
    amountPaise: Math.abs(line.amountPaise),
    signedPaise: line.amountPaise,
  }));
  return {
    periodStartKey,
    periodEndKey,
    periodNetPaise: period.netPaise,
    incomePaise: period.incomePaise,
    expensePaise: period.expensePaise,
    alreadyDistributedPaise: alreadySigned,
    availablePaise,
    distributingPaise: distributing,
    kind: distributing > 0 ? 'profit' : 'loss',
    lines,
  };
}

export function recordIncome(input, userId) {
  return commitOnce(Income, input.idempotencyKey, async (session) => {
    const bank = await accountForMethod(session, input.paymentMethod, input.bankAccountId);
    const incomeAccount = await categoryAccount(session, 'income', input.category);
    const [doc] = await Income.create(
      [
        {
          ...input,
          journalEntryId: undefined,
          bankAccountId: bank._id,
          paymentMethod: methodName(input.paymentMethod),
          recordedBy: userId,
          voided: false,
        },
      ],
      { session },
    );
    const client = input.clientId ? await Client.findById(input.clientId).session(session) : null;
    const posted = await postEntry({
      session,
      dateKey: input.dateKey,
      memo: input.title,
      sourceType: 'income',
      sourceId: doc._id,
      lines: [
        { accountId: bank.ledgerAccountId, debitPaise: input.amountPaise },
        { accountId: incomeAccount._id, creditPaise: input.amountPaise },
      ],
      idempotencyKey: input.idempotencyKey,
      userId,
      method: methodName(input.paymentMethod),
      counterparty: client?.name || '',
    });
    doc.journalEntryId = posted.entry._id;
    doc.reference = posted.reference;
    await doc.save({ session });
    return doc;
  });
}

export function recordExpense(input, userId) {
  return commitOnce(Expense, input.idempotencyKey, async (session) => {
    const expenseAccount = await categoryAccount(session, 'expense', input.category);
    let creditAccount;
    let bank;
    let founder;
    if (input.paidByType === 'founder') {
      founder = await CoFounder.findById(input.paidByFounderId).session(session);
      if (!founder || founder.accountStatus !== 'active') throw new HttpError('Choose an active co-founder');
      if (!founder.ledgerAccountId) throw new HttpError('This co-founder has no capital account');
      creditAccount = founder.ledgerAccountId;
    } else {
      bank = await accountForMethod(session, input.paymentMethod, input.bankAccountId);
      creditAccount = bank.ledgerAccountId;
    }
    const recurring = Boolean(input.isRecurring);
    const [doc] = await Expense.create(
      [
        {
          ...input,
          bankAccountId: bank?._id,
          paymentMethod: founder ? input.paymentMethod : methodName(input.paymentMethod),
          paidByFounderId: founder?._id,
          isRecurring: recurring,
          recurrenceActive: recurring,
          recurrenceGroupId: input.recurrenceGroupId || crypto.randomUUID(),
          nextRunDate: recurring ? addMonths(input.dateKey, 1) : undefined,
          recordedBy: userId,
          voided: false,
        },
      ],
      { session },
    );
    if (input.supersedeId) {
      await Expense.updateOne(
        { _id: input.supersedeId },
        { $set: { recurrenceActive: false }, $unset: { nextRunDate: '' } },
        { session },
      );
    }
    const posted = await postEntry({
      session,
      dateKey: input.dateKey,
      memo: input.title,
      sourceType: 'expense',
      sourceId: doc._id,
      lines: [
        { accountId: expenseAccount._id, debitPaise: input.amountPaise, partyType: founder ? 'founder' : '', partyId: founder?._id },
        { accountId: creditAccount, creditPaise: input.amountPaise, partyType: founder ? 'founder' : '', partyId: founder?._id },
      ],
      idempotencyKey: input.idempotencyKey,
      userId,
      method: founder ? input.paymentMethod : methodName(input.paymentMethod),
      counterparty: founder?.fullName || '',
    });
    doc.journalEntryId = posted.entry._id;
    doc.reference = posted.reference;
    await doc.save({ session });
    return doc;
  });
}

export function updateIncome(id, input, userId) {
  return runTxn(async (session) => {
    const doc = await Income.findById(id).session(session);
    if (!doc || doc.voided) throw new HttpError('Income record not found', 404);
    if (String(doc.idempotencyKey || '').startsWith('receipt:')) {
      throw new HttpError('Edit this from Client payments so the bank and the receipt stay together');
    }
    const bank = await accountForMethod(session, input.paymentMethod, input.bankAccountId);
    const incomeAccount = await categoryAccount(session, 'income', input.category);
    const client = input.clientId ? await Client.findById(input.clientId).session(session) : null;
    if (doc.journalEntryId) {
      const entry = await JournalEntry.findById(doc.journalEntryId).session(session);
      if (entry?.status === 'posted') {
        await reverseEntry({ session, entryId: entry._id, userId, reason: 'Edited income', dateKey: input.dateKey });
      }
    }
    const method = methodName(input.paymentMethod);
    const posted = await postEntry({
      session,
      dateKey: input.dateKey,
      memo: input.title,
      sourceType: 'income',
      sourceId: doc._id,
      lines: [
        { accountId: bank.ledgerAccountId, debitPaise: input.amountPaise },
        { accountId: incomeAccount._id, creditPaise: input.amountPaise },
      ],
      idempotencyKey: `edit-income:${doc._id}:${Date.now()}`,
      userId,
      method,
      counterparty: client?.name || '',
    });
    doc.title = input.title;
    doc.amountPaise = input.amountPaise;
    doc.dateKey = input.dateKey;
    doc.category = input.category;
    doc.clientId = input.clientId;
    doc.bankAccountId = bank._id;
    doc.paymentMethod = method;
    doc.description = input.description || '';
    doc.journalEntryId = posted.entry._id;
    doc.reference = posted.reference;
    await doc.save({ session });
    return doc;
  });
}

export function updateExpense(id, input, userId) {
  return runTxn(async (session) => {
    const doc = await Expense.findById(id).session(session);
    if (!doc || doc.voided) throw new HttpError('Expense record not found', 404);
    const expenseAccount = await categoryAccount(session, 'expense', input.category);
    let creditAccount;
    let bank;
    let founder;
    if (input.paidByType === 'founder') {
      founder = await CoFounder.findById(input.paidByFounderId).session(session);
      if (!founder || founder.accountStatus !== 'active') throw new HttpError('Choose an active co-founder');
      if (!founder.ledgerAccountId) throw new HttpError('This co-founder has no capital account');
      creditAccount = founder.ledgerAccountId;
    } else {
      bank = await accountForMethod(session, input.paymentMethod, input.bankAccountId);
      creditAccount = bank.ledgerAccountId;
    }
    if (doc.journalEntryId) {
      const entry = await JournalEntry.findById(doc.journalEntryId).session(session);
      if (entry?.status === 'posted') {
        await reverseEntry({ session, entryId: entry._id, userId, reason: 'Edited expense', dateKey: input.dateKey });
      }
    }
    const method = founder ? input.paymentMethod || '' : methodName(input.paymentMethod);
    const posted = await postEntry({
      session,
      dateKey: input.dateKey,
      memo: input.title,
      sourceType: 'expense',
      sourceId: doc._id,
      lines: [
        { accountId: expenseAccount._id, debitPaise: input.amountPaise, partyType: founder ? 'founder' : '', partyId: founder?._id },
        { accountId: creditAccount, creditPaise: input.amountPaise, partyType: founder ? 'founder' : '', partyId: founder?._id },
      ],
      idempotencyKey: `edit-expense:${doc._id}:${Date.now()}`,
      userId,
      method,
      counterparty: founder?.fullName || '',
    });
    const recurring = Boolean(input.isRecurring);
    doc.title = input.title;
    doc.amountPaise = input.amountPaise;
    doc.category = input.category;
    doc.dateKey = input.dateKey;
    doc.paidByType = input.paidByType;
    doc.paidByFounderId = founder ? founder._id : null;
    doc.bankAccountId = bank ? bank._id : null;
    doc.paymentMethod = method;
    doc.description = input.description || '';
    doc.isRecurring = recurring;
    doc.recurrenceActive = recurring;
    doc.nextRunDate = recurring ? doc.nextRunDate || addMonths(input.dateKey, 1) : undefined;
    doc.journalEntryId = posted.entry._id;
    doc.reference = posted.reference;
    await doc.save({ session });
    return doc;
  });
}

export async function processRecurringExpenses(userId) {
  const today = todayKey((await getSettings()).timezone);
  const due = await Expense.find({
    isRecurring: true,
    recurrenceActive: true,
    voided: false,
    nextRunDate: { $lte: today },
  }).limit(40);
  const created = [];
  for (const source of due) {
    const doc = await recordExpense(
      {
        title: source.title,
        amountPaise: source.amountPaise,
        category: source.category,
        dateKey: source.nextRunDate,
        time: source.time,
        paidByType: source.paidByType,
        paidByFounderId: source.paidByFounderId,
        bankAccountId: source.bankAccountId,
        paymentMethod: source.paymentMethod,
        description: source.description,
        isRecurring: true,
        recurrenceGroupId: source.recurrenceGroupId,
        supersedeId: source._id,
        idempotencyKey: `recur:${source.recurrenceGroupId}:${source.nextRunDate}`,
      },
      userId || source.recordedBy,
    );
    created.push(doc);
  }
  return created;
}

export function recordContribution(input, userId) {
  return commitOnce(FounderContribution, input.idempotencyKey, async (session) => {
    const founder = await CoFounder.findById(input.coFounderId).session(session);
    if (!founder || founder.accountStatus !== 'active') throw new HttpError('Choose an active co-founder');
    const bank = await activeBank(session, input.bankAccountId);
    const [doc] = await FounderContribution.create([{ ...input, recordedBy: userId, voided: false }], { session });
    const posted = await postEntry({
      session,
      dateKey: input.dateKey,
      memo: `${input.kind === 'initial' ? 'Initial capital' : 'Additional capital'} · ${founder.fullName}`,
      sourceType: 'founder_contribution',
      sourceId: doc._id,
      lines: [
        { accountId: bank.ledgerAccountId, debitPaise: input.amountPaise },
        { accountId: founder.ledgerAccountId, creditPaise: input.amountPaise, partyType: 'founder', partyId: founder._id },
      ],
      idempotencyKey: input.idempotencyKey,
      userId,
      method: input.paymentMethod,
      counterparty: founder.fullName,
    });
    doc.journalEntryId = posted.entry._id;
    doc.reference = posted.reference;
    await doc.save({ session });
    return doc;
  });
}

export function recordWithdrawal(input, userId) {
  return commitOnce(FounderWithdrawal, input.idempotencyKey, async (session) => {
    const founder = await CoFounder.findById(input.coFounderId).session(session);
    if (!founder || founder.accountStatus !== 'active') throw new HttpError('Choose an active co-founder');
    const parts = await founderParts(founder._id, session);
    if (input.kind === 'reimbursement' && input.amountPaise > parts.reimbursementDuePaise) {
      throw new HttpError('Reimbursement is higher than the expenses this co-founder paid personally');
    }
    if (input.kind === 'withdrawal' && input.amountPaise > parts.ledgerBalancePaise && !input.allowCapitalOverdraw) {
      throw new HttpError('This withdrawal is higher than the co-founder capital balance. Confirm it to continue.');
    }
    const bank = await activeBank(session, input.bankAccountId);
    const [doc] = await FounderWithdrawal.create(
      [{ ...input, recordedBy: userId, voided: false, allowCapitalOverdraw: undefined }],
      { session },
    );
    const posted = await postEntry({
      session,
      dateKey: input.dateKey,
      memo: `${input.kind === 'reimbursement' ? 'Reimbursement' : 'Withdrawal'} · ${founder.fullName}`,
      sourceType: 'founder_withdrawal',
      sourceId: doc._id,
      lines: [
        { accountId: founder.ledgerAccountId, debitPaise: input.amountPaise, partyType: 'founder', partyId: founder._id },
        { accountId: bank.ledgerAccountId, creditPaise: input.amountPaise },
      ],
      idempotencyKey: input.idempotencyKey,
      userId,
      method: input.paymentMethod,
      counterparty: founder.fullName,
    });
    doc.journalEntryId = posted.entry._id;
    doc.reference = posted.reference;
    await doc.save({ session });
    return doc;
  });
}

export function recordDistribution(input, userId) {
  return commitOnce(ProfitDistribution, input.idempotencyKey, async (session) => {
    const preview = await previewDistribution(input);
    if (input.payout) {
      if (preview.kind !== 'profit') throw new HttpError('A loss is allocated to capital. It is not paid out in cash.');
      if (!input.bankAccountId) throw new HttpError('Choose the account that will pay the distribution');
    }
    const retained = await accountByCode(session, '3000');
    const activeLines = preview.lines.filter((line) => line.amountPaise > 0);
    const founders = await CoFounder.find({ _id: { $in: activeLines.map((line) => line.coFounderId) } }).session(session);
    const byId = new Map(founders.map((founder) => [String(founder._id), founder]));
    const lines = activeLines.map((line) => {
      const founder = byId.get(String(line.coFounderId));
      if (!founder?.ledgerAccountId) throw new HttpError(`${line.name} has no capital account`);
      return preview.kind === 'profit'
        ? { accountId: founder.ledgerAccountId, creditPaise: line.amountPaise, partyType: 'founder', partyId: founder._id, memo: founder.fullName }
        : { accountId: founder.ledgerAccountId, debitPaise: line.amountPaise, partyType: 'founder', partyId: founder._id, memo: founder.fullName };
    });
    lines.push(
      preview.kind === 'profit'
        ? { accountId: retained._id, debitPaise: Math.abs(preview.distributingPaise), memo: 'Profit allocation' }
        : { accountId: retained._id, creditPaise: Math.abs(preview.distributingPaise), memo: 'Loss allocation' },
    );
    const [doc] = await ProfitDistribution.create(
      [
        {
          periodStartKey: input.periodStartKey,
          periodEndKey: input.periodEndKey,
          periodNetPaise: preview.periodNetPaise,
          signedPaise: preview.distributingPaise,
          kind: preview.kind,
          payout: Boolean(input.payout),
          bankAccountId: input.bankAccountId,
          lines: activeLines.map((line) => ({
            coFounderId: line.coFounderId,
            name: line.name,
            bps: line.bps,
            amountPaise: line.amountPaise,
          })),
          notes: input.notes || '',
          idempotencyKey: input.idempotencyKey,
          approvedBy: userId,
          voided: false,
        },
      ],
      { session },
    );
    const posted = await postEntry({
      session,
      dateKey: input.dateKey,
      memo: `${preview.kind === 'profit' ? 'Profit distribution' : 'Loss allocation'} ${input.periodStartKey} to ${input.periodEndKey}`,
      sourceType: 'profit_distribution',
      sourceId: doc._id,
      lines,
      idempotencyKey: input.idempotencyKey,
      userId,
    });
    doc.journalEntryId = posted.entry._id;
    doc.reference = posted.reference;
    if (input.payout) {
      const bank = await activeBank(session, input.bankAccountId);
      const payoutLines = activeLines.map((line) => {
        const founder = byId.get(String(line.coFounderId));
        return { accountId: founder.ledgerAccountId, debitPaise: line.amountPaise, partyType: 'founder', partyId: founder._id, memo: `Payout · ${founder.fullName}` };
      });
      const payoutTotal = activeLines.reduce((sum, line) => sum + line.amountPaise, 0);
      payoutLines.push({ accountId: bank.ledgerAccountId, creditPaise: payoutTotal, memo: 'Profit payout' });
      const payout = await postEntry({
        session,
        dateKey: input.dateKey,
        memo: `Profit payout ${input.periodStartKey} to ${input.periodEndKey}`,
        sourceType: 'profit_payout',
        sourceId: doc._id,
        lines: payoutLines,
        idempotencyKey: `${input.idempotencyKey}:payout`,
        userId,
        method: input.paymentMethod,
      });
      doc.payoutJournalEntryId = payout.entry._id;
      await FounderWithdrawal.create(
        activeLines.map((line) => ({
          coFounderId: line.coFounderId,
          kind: 'withdrawal',
          amountPaise: line.amountPaise,
          dateKey: input.dateKey,
          bankAccountId: bank._id,
          paymentMethod: input.paymentMethod,
          notes: 'Profit distribution payout',
          journalEntryId: payout.entry._id,
          reference: payout.reference,
          distributionId: doc._id,
          idempotencyKey: `${input.idempotencyKey}:payout:${line.coFounderId}`,
          recordedBy: userId,
          voided: false,
        })),
        { session },
      );
    }
    await doc.save({ session });
    return doc;
  });
}

export function transferFunds(input, userId) {
  return runTxn(async (session) => {
    if (String(input.fromAccountId) === String(input.toAccountId)) throw new HttpError('Choose two different accounts');
    const from = await activeBank(session, input.fromAccountId);
    const to = await activeBank(session, input.toAccountId);
    return postEntry({
      session,
      dateKey: input.dateKey,
      memo: input.memo || `Transfer · ${from.accountName} to ${to.accountName}`,
      sourceType: 'bank_transfer',
      lines: [
        { accountId: to.ledgerAccountId, debitPaise: input.amountPaise },
        { accountId: from.ledgerAccountId, creditPaise: input.amountPaise },
      ],
      idempotencyKey: input.idempotencyKey,
      userId,
      method: 'bank_transfer',
    });
  });
}

export function reconcileAccount(bankId, input, userId) {
  return runTxn(async (session) => {
    const bank = await BankAccount.findById(bankId).session(session);
    if (!bank) throw new HttpError('Account not found', 404);
    const difference = input.statementBalancePaise - bank.currentBalancePaise;
    bank.reconciliations.push({
      asOf: input.asOf,
      statementBalancePaise: input.statementBalancePaise,
      bookBalancePaise: bank.currentBalancePaise,
      differencePaise: difference,
      notes: input.notes || '',
      by: userId,
    });
    await bank.save({ session });
    return bank;
  });
}

export function openBankAccount(input, userId) {
  return runTxn(async (session) => {
    const counter = await mongoose.model('Counter').findOneAndUpdate(
      { _id: 'bank' },
      { $inc: { seq: 1 } },
      { upsert: true, new: true, session },
    );
    const [ledger] = await LedgerAccount.create(
      [
        {
          code: `BANK${String(counter.seq).padStart(4, '0')}`,
          name: input.accountName,
          type: 'asset',
          subtype: input.accountType,
          normalBalance: 'debit',
          ownerType: 'bank',
          isSystem: false,
        },
      ],
      { session },
    );
    const [bank] = await BankAccount.create(
      [
        {
          ...input,
          openingBalancePaise: input.openingBalancePaise,
          currentBalancePaise: 0,
          ledgerAccountId: ledger._id,
          status: 'active',
        },
      ],
      { session },
    );
    ledger.bankAccountId = bank._id;
    ledger.ownerId = bank._id;
    await ledger.save({ session });
    if (input.openingBalancePaise > 0) {
      const equity = await accountByCode(session, '3900');
      await postEntry({
        session,
        dateKey: input.openingDate,
        memo: `Opening balance · ${input.accountName}`,
        sourceType: 'opening_balance',
        sourceId: bank._id,
        userId,
        lines: [
          { accountId: ledger._id, debitPaise: input.openingBalancePaise },
          { accountId: equity._id, creditPaise: input.openingBalancePaise },
        ],
      });
    }
    return bank;
  });
}

export function createClientRecord(input) {
  return runTxn(async (session) => {
    const [client] = await Client.create([input], { session });
    await createReceivableAccount(session, client);
    return client;
  });
}

export function createCharge(input, userId) {
  return runTxn(async (session) => {
    const client = await Client.findById(input.clientId).session(session);
    if (!client) throw new HttpError('Client not found', 404);
    if (RECURRING_PAYMENT_TYPES.includes(input.paymentType)) {
      const duplicate = await ClientPayment.findOne({
        clientId: client._id,
        periodKey: input.periodKey,
        paymentType: input.paymentType,
        voided: false,
      }).session(session);
      if (duplicate) throw new HttpError('A payment record already exists for this client and billing period', 409);
    }
    const today = todayKey((await getSettings()).timezone);
    const [doc] = await ClientPayment.create(
      [
        {
          ...input,
          amountReceivedPaise: 0,
          status: paymentStatus(input.invoiceAmountPaise, 0, input.dueDate, today),
          recordedBy: userId,
          voided: false,
        },
      ],
      { session },
    );
    return doc;
  });
}

export function voidCharge(paymentId) {
  return runTxn(async (session) => {
    const payment = await ClientPayment.findById(paymentId).session(session);
    if (!payment || payment.voided) throw new HttpError('Payment record not found', 404);
    if (payment.amountReceivedPaise > 0) throw new HttpError('Reverse the receipts before voiding this charge');
    payment.voided = true;
    payment.status = 'void';
    await payment.save({ session });
    return payment;
  });
}

export function updateCharge(paymentId, input) {
  return runTxn(async (session) => {
    const payment = await ClientPayment.findById(paymentId).session(session);
    if (!payment || payment.voided) throw new HttpError('Payment record not found', 404);
    if (input.invoiceAmountPaise < payment.amountReceivedPaise) {
      throw new HttpError('Amount cannot be less than what the client has already paid');
    }
    payment.paymentType = input.paymentType;
    payment.invoiceAmountPaise = input.invoiceAmountPaise;
    if (input.dueDate !== undefined) payment.dueDate = input.dueDate || '';
    const today = todayKey((await getSettings()).timezone);
    payment.status = paymentStatus(payment.invoiceAmountPaise, payment.amountReceivedPaise, payment.dueDate, today);
    await payment.save({ session });
    const client = await Client.findById(payment.clientId).session(session);
    const keys = payment.receipts.filter((item) => !item.reversed).map((item) => `receipt:${item._id}`);
    if (client && keys.length) {
      await Income.updateMany(
        { idempotencyKey: { $in: keys } },
        { $set: { title: `${client.name} · ${payment.paymentType}` } },
        { session },
      );
    }
    return payment;
  });
}

async function postReceiptJournal(session, payment, client, bank, input, userId, receiptId) {
  const lines = [{ accountId: bank.ledgerAccountId, debitPaise: input.amountPaise }];
  if (payment.invoiceId) {
    const invoice = await Invoice.findById(payment.invoiceId).session(session);
    if (!invoice || ['draft', 'cancelled'].includes(invoice.status)) throw new HttpError('The linked invoice cannot take a payment');
    if (input.amountPaise > invoice.totalPaise - invoice.amountPaidPaise) {
      throw new HttpError('Amount is more than the invoice balance');
    }
    lines.push({ accountId: client.ledgerAccountId, creditPaise: input.amountPaise, partyType: 'client', partyId: client._id });
  } else {
    const income = await categoryAccount(session, 'income', 'Client Payments');
    lines.push({ accountId: income._id, creditPaise: input.amountPaise });
  }
  return postEntry({
    session,
    dateKey: input.dateKey,
    memo: `Client receipt · ${client.name}`,
    sourceType: 'client_receipt',
    sourceId: payment._id,
    sourceSubId: receiptId,
    lines,
    idempotencyKey: input.idempotencyKey,
    userId,
    method: methodName(input.paymentMethod),
    counterparty: client.name,
  });
}

async function syncReceiptIncome(session, payment, client, receipt, bank, posted, userId) {
  const key = `receipt:${receipt._id}`;
  const fields = {
    title: `${client.name} · ${payment.paymentType}`,
    amountPaise: receipt.amountPaise,
    dateKey: receipt.dateKey,
    category: 'Client Payments',
    clientId: client._id,
    bankAccountId: bank._id,
    paymentMethod: receipt.paymentMethod,
    description: 'Received on a client payment',
    journalEntryId: posted.entry._id,
    reference: posted.reference,
    voided: false,
  };
  const income = await Income.findOne({ idempotencyKey: key }).session(session);
  if (!income) {
    await Income.create([{ ...fields, idempotencyKey: key, recordedBy: userId }], { session });
    return;
  }
  Object.assign(income, fields);
  await income.save({ session });
}

export function recordClientReceipt(paymentId, input, userId) {
  return runTxn(async (session) => {
    const payment = await ClientPayment.findById(paymentId).session(session);
    if (!payment || payment.voided) throw new HttpError('Payment record not found', 404);
    if (input.idempotencyKey && payment.receipts.some((receipt) => receipt.idempotencyKey === input.idempotencyKey && !receipt.reversed)) {
      return payment;
    }
    const outstanding = payment.invoiceAmountPaise - payment.amountReceivedPaise;
    if (input.amountPaise > outstanding) throw new HttpError('Amount is more than the outstanding balance');
    const client = await Client.findById(payment.clientId).session(session);
    const bank = await accountForMethod(session, input.paymentMethod, input.bankAccountId);
    const method = methodName(input.paymentMethod);
    const receiptId = new mongoose.Types.ObjectId();
    const posted = await postReceiptJournal(session, payment, client, bank, { ...input, paymentMethod: method }, userId, receiptId);
    payment.receipts.push({
      _id: receiptId,
      amountPaise: input.amountPaise,
      dateKey: input.dateKey,
      paymentMethod: method,
      transactionReference: input.transactionReference || '',
      bankAccountId: bank._id,
      journalEntryId: posted.entry._id,
      note: input.note || '',
      idempotencyKey: input.idempotencyKey,
      recordedBy: userId,
    });
    payment.amountReceivedPaise += input.amountPaise;
    const today = todayKey((await getSettings()).timezone);
    payment.status = paymentStatus(payment.invoiceAmountPaise, payment.amountReceivedPaise, payment.dueDate, today);
    await payment.save({ session });
    const receipt = payment.receipts.id(receiptId);
    if (payment.invoiceId) await addInvoiceReceipt(session, payment.invoiceId, { ...input, paymentMethod: method, bankAccountId: bank._id }, posted.entry._id, userId, today);
    else await syncReceiptIncome(session, payment, client, receipt, bank, posted, userId);
    return payment;
  });
}

export function updateClientReceipt(paymentId, receiptId, input, userId) {
  return runTxn(async (session) => {
    const payment = await ClientPayment.findById(paymentId).session(session);
    if (!payment || payment.voided) throw new HttpError('Payment record not found', 404);
    const receipt = payment.receipts.id(receiptId);
    if (!receipt || receipt.reversed) throw new HttpError('Receipt not found', 404);
    const kept = payment.receipts.filter((item) => !item.reversed && String(item._id) !== String(receipt._id));
    const keptSum = kept.reduce((sum, item) => sum + item.amountPaise, 0);
    if (keptSum + input.amountPaise > payment.invoiceAmountPaise) {
      throw new HttpError('That is more than the amount still pending');
    }
    const client = await Client.findById(payment.clientId).session(session);
    const bank = await accountForMethod(session, input.paymentMethod, input.bankAccountId);
    const method = methodName(input.paymentMethod);
    const today = todayKey((await getSettings()).timezone);
    if (payment.invoiceId && receipt.journalEntryId) {
      await reverseInvoiceReceipt(session, payment.invoiceId, receipt.journalEntryId, today);
    }
    if (receipt.journalEntryId) {
      const entry = await JournalEntry.findById(receipt.journalEntryId).session(session);
      if (entry?.status === 'posted') {
        await reverseEntry({ session, entryId: entry._id, userId, reason: 'Edited client receipt', dateKey: input.dateKey });
      }
    }
    const posted = await postReceiptJournal(
      session,
      payment,
      client,
      bank,
      { ...input, paymentMethod: method, idempotencyKey: `edit-receipt:${receipt._id}:${Date.now()}` },
      userId,
      receipt._id,
    );
    receipt.amountPaise = input.amountPaise;
    receipt.dateKey = input.dateKey;
    receipt.paymentMethod = method;
    receipt.bankAccountId = bank._id;
    receipt.journalEntryId = posted.entry._id;
    receipt.note = input.note || '';
    payment.amountReceivedPaise = keptSum + input.amountPaise;
    payment.status = paymentStatus(payment.invoiceAmountPaise, payment.amountReceivedPaise, payment.dueDate, today);
    await payment.save({ session });
    if (payment.invoiceId) {
      await addInvoiceReceipt(session, payment.invoiceId, { ...input, paymentMethod: method, bankAccountId: bank._id }, posted.entry._id, userId, today);
    } else {
      await syncReceiptIncome(session, payment, client, receipt, bank, posted, userId);
    }
    return payment;
  });
}

async function addInvoiceReceipt(session, invoiceId, input, journalEntryId, userId, today) {
  const invoice = await Invoice.findById(invoiceId).session(session);
  if (input.amountPaise > invoice.totalPaise - invoice.amountPaidPaise) {
    throw new HttpError('Amount is more than the invoice balance');
  }
  invoice.receipts.push({
    amountPaise: input.amountPaise,
    dateKey: input.dateKey,
    paymentMethod: input.paymentMethod,
    transactionReference: input.transactionReference || '',
    bankAccountId: input.bankAccountId,
    journalEntryId,
    note: input.note || '',
    idempotencyKey: input.idempotencyKey,
    recordedBy: userId,
  });
  invoice.amountPaidPaise += input.amountPaise;
  invoice.status = invoiceStatus(invoice, today);
  await invoice.save({ session });
}

export function priceInvoice(items, discountPaise, taxBps) {
  const priced = items.map((item) => {
    const milli = quantityMilli(item.quantity);
    const ratePaise = item.ratePaise;
    if (!Number.isInteger(ratePaise) || ratePaise < 0) throw new HttpError('Enter a valid rate');
    return {
      description: item.description,
      quantityMilli: milli,
      quantity: formatQuantity(milli),
      ratePaise,
      amountPaise: lineAmountPaise(milli, ratePaise),
    };
  });
  const subtotalPaise = priced.reduce((sum, item) => sum + item.amountPaise, 0);
  if (discountPaise > subtotalPaise) throw new HttpError('Discount cannot exceed the subtotal');
  const taxable = subtotalPaise - discountPaise;
  const tax = percentageOf(taxable, taxBps);
  return { items: priced, subtotalPaise, discountPaise, taxBps, taxPaise: tax, totalPaise: taxable + tax };
}

export function saveDraftInvoice(input, userId, invoiceId) {
  return runTxn(async (session) => {
    const priced = priceInvoice(input.items, input.discountPaise, input.taxBps);
    if (priced.totalPaise <= 0) throw new HttpError('Invoice total must be greater than zero');
    const client = await Client.findById(input.clientId).session(session);
    if (!client) throw new HttpError('Client not found', 404);
    let invoice;
    if (invoiceId) {
      invoice = await Invoice.findById(invoiceId).session(session);
      if (!invoice) throw new HttpError('Invoice not found', 404);
      if (invoice.status !== 'draft') throw new HttpError('Only a draft invoice can be edited');
      Object.assign(invoice, {
        clientId: client._id,
        projectId: input.projectId,
        dateKey: input.dateKey,
        dueDate: input.dueDate,
        incomeCategory: input.incomeCategory,
        notes: input.notes,
        subtotalPaise: priced.subtotalPaise,
        discountPaise: priced.discountPaise,
        taxBps: priced.taxBps,
        taxPaise: priced.taxPaise,
        totalPaise: priced.totalPaise,
      });
      await invoice.save({ session });
      await InvoiceItem.deleteMany({ invoiceId: invoice._id }).session(session);
    } else {
      const [created] = await Invoice.create(
        [
          {
            clientId: client._id,
            projectId: input.projectId,
            dateKey: input.dateKey,
            dueDate: input.dueDate,
            incomeCategory: input.incomeCategory,
            notes: input.notes || '',
            status: 'draft',
            subtotalPaise: priced.subtotalPaise,
            discountPaise: priced.discountPaise,
            taxBps: priced.taxBps,
            taxPaise: priced.taxPaise,
            totalPaise: priced.totalPaise,
            amountPaidPaise: 0,
            createdBy: userId,
            idempotencyKey: input.idempotencyKey,
          },
        ],
        { session },
      );
      invoice = created;
    }
    await InvoiceItem.insertMany(
      priced.items.map((item) => ({ ...item, invoiceId: invoice._id })),
      { session },
    );
    return invoice;
  });
}

export function issueInvoice(invoiceId, userId) {
  return runTxn(async (session) => {
    const invoice = await Invoice.findById(invoiceId).session(session);
    if (!invoice) throw new HttpError('Invoice not found', 404);
    if (invoice.status !== 'draft') throw new HttpError('This invoice is already issued');
    const client = await Client.findById(invoice.clientId).session(session);
    if (!client?.ledgerAccountId) throw new HttpError('This client has no receivable account');
    const settings = await getSettings();
    const year = invoice.dateKey.slice(0, 4);
    const counter = await mongoose.model('Counter').findOneAndUpdate(
      { _id: `invoice:${year}` },
      { $inc: { seq: 1 } },
      { upsert: true, new: true, session },
    );
    invoice.number = `${settings.invoicePrefix || 'DM'}-${year}-${String(counter.seq).padStart(4, '0')}`;
    const income = await categoryAccount(session, 'income', invoice.incomeCategory || 'Client Payments');
    const taxable = invoice.totalPaise - invoice.taxPaise;
    const lines = [{ accountId: client.ledgerAccountId, debitPaise: invoice.totalPaise, partyType: 'client', partyId: client._id }];
    if (invoice.taxPaise > 0) {
      const gst = await accountByCode(session, '2100');
      lines.push({ accountId: income._id, creditPaise: taxable });
      lines.push({ accountId: gst._id, creditPaise: invoice.taxPaise });
    } else {
      lines.push({ accountId: income._id, creditPaise: invoice.totalPaise });
    }
    const posted = await postEntry({
      session,
      dateKey: invoice.dateKey,
      memo: `Invoice ${invoice.number} · ${client.name}`,
      sourceType: 'invoice',
      sourceId: invoice._id,
      lines,
      idempotencyKey: `issue:${invoice._id}:${invoice.number || 'draft'}`,
      userId,
      counterparty: client.name,
    });
    invoice.journalEntryId = posted.entry._id;
    invoice.paymentInstructions = invoice.paymentInstructions || settings.paymentInstructions || '';
    const today = todayKey(settings.timezone);
    invoice.sentAt = invoice.sentAt || new Date();
    invoice.status = invoice.dueDate < today ? 'overdue' : 'sent';
    await invoice.save({ session });
    const linked = await ClientPayment.findOne({ invoiceId: invoice._id, voided: false }).session(session);
    if (!linked) {
      await ClientPayment.create([invoiceChargeFields(invoice, userId, today)], { session });
    }
    return invoice;
  });
}

function invoiceChargeFields(invoice, userId, today) {
  const dueDate = invoice.dueDate || invoice.dateKey || today;
  const received = Math.min(Number(invoice.amountPaidPaise || 0), invoice.totalPaise);
  return {
    clientId: invoice.clientId,
    projectId: invoice.projectId,
    invoiceId: invoice._id,
    paymentType: invoice.number ? `Invoice ${invoice.number}` : 'Invoice',
    periodKey: `invoice-${invoice._id}`,
    invoiceAmountPaise: invoice.totalPaise,
    amountReceivedPaise: received,
    dueDate,
    status: paymentStatus(invoice.totalPaise, received, dueDate, today),
    notes: invoice.number || '',
    recordedBy: userId,
    voided: false,
  };
}

export async function ensureSentInvoicePayments(userId) {
  const unmarked = await Invoice.find({ status: { $in: ['sent', 'partial', 'paid', 'overdue'] }, $or: [{ sentAt: null }, { sentAt: { $exists: false } }] });
  for (const invoice of unmarked) {
    invoice.sentAt = invoice.updatedAt || new Date();
    await invoice.save();
  }
  const invoices = await Invoice.find({ status: { $in: ['sent', 'partial', 'paid', 'overdue'] }, totalPaise: { $gt: 0 } });
  if (!invoices.length) return;
  const existing = await ClientPayment.find({ invoiceId: { $in: invoices.map((invoice) => invoice._id) }, voided: false }).select('invoiceId');
  const have = new Set(existing.map((row) => String(row.invoiceId)));
  const missing = invoices.filter((invoice) => !have.has(String(invoice._id)));
  if (!missing.length) return;
  const today = todayKey((await getSettings()).timezone);
  await ClientPayment.insertMany(missing.map((invoice) => invoiceChargeFields(invoice, userId, today)));
}

export function voidInvoicePayment(invoiceId) {
  return runTxn(async (session) => {
    const payment = await ClientPayment.findOne({ invoiceId, voided: false }).session(session);
    if (!payment) return null;
    const openReceipt = payment.receipts.some((receipt) => !receipt.reversed);
    if (payment.amountReceivedPaise > 0 && openReceipt) {
      throw new HttpError('Reverse the receipts before changing this invoice');
    }
    payment.amountReceivedPaise = 0;
    payment.voided = true;
    payment.status = 'void';
    await payment.save({ session });
    return payment;
  });
}

export function recordInvoiceReceipt(invoiceId, input, userId) {
  return runTxn(async (session) => {
    const invoice = await Invoice.findById(invoiceId).session(session);
    if (!invoice) throw new HttpError('Invoice not found', 404);
    if (['draft', 'cancelled', 'paid'].includes(invoice.status)) throw new HttpError('This invoice cannot take a payment');
    if (input.idempotencyKey && invoice.receipts.some((receipt) => receipt.idempotencyKey === input.idempotencyKey && !receipt.reversed)) {
      return invoice;
    }
    const outstanding = invoice.totalPaise - invoice.amountPaidPaise;
    if (input.amountPaise > outstanding) throw new HttpError('Amount is more than the balance due');
    const client = await Client.findById(invoice.clientId).session(session);
    const bank = await activeBank(session, input.bankAccountId);
    const receiptId = new mongoose.Types.ObjectId();
    const posted = await postEntry({
      session,
      dateKey: input.dateKey,
      memo: `Invoice receipt · ${invoice.number}`,
      sourceType: 'invoice_receipt',
      sourceId: invoice._id,
      sourceSubId: receiptId,
      lines: [
        { accountId: bank.ledgerAccountId, debitPaise: input.amountPaise },
        { accountId: client.ledgerAccountId, creditPaise: input.amountPaise, partyType: 'client', partyId: client._id },
      ],
      idempotencyKey: input.idempotencyKey,
      userId,
      method: input.paymentMethod,
      counterparty: client.name,
    });
    const today = todayKey((await getSettings()).timezone);
    invoice.receipts.push({
      _id: receiptId,
      amountPaise: input.amountPaise,
      dateKey: input.dateKey,
      paymentMethod: input.paymentMethod,
      transactionReference: input.transactionReference || '',
      bankAccountId: bank._id,
      journalEntryId: posted.entry._id,
      note: input.note || '',
      idempotencyKey: input.idempotencyKey,
      recordedBy: userId,
    });
    invoice.amountPaidPaise += input.amountPaise;
    invoice.status = invoiceStatus(invoice, today);
    await invoice.save({ session });
    if (input.clientPaymentId) {
      const payment = await ClientPayment.findById(input.clientPaymentId).session(session);
      if (payment && !payment.voided && String(payment.clientId) === String(invoice.clientId)) {
        payment.invoiceId = invoice._id;
        payment.amountReceivedPaise += input.amountPaise;
        payment.status = paymentStatus(payment.invoiceAmountPaise, payment.amountReceivedPaise, payment.dueDate, today);
        payment.receipts.push({
          amountPaise: input.amountPaise,
          dateKey: input.dateKey,
          paymentMethod: input.paymentMethod,
          bankAccountId: bank._id,
          journalEntryId: posted.entry._id,
          note: 'Applied from invoice',
          idempotencyKey: `${input.idempotencyKey}:schedule`,
          recordedBy: userId,
        });
        await payment.save({ session });
      }
    }
    return invoice;
  });
}

export async function advanceBalance(employeeId, session) {
  const account = await LedgerAccount.findOne({ code: '1300' }).session(session);
  if (!account) return 0;
  const [row] = await aggregate(
    JournalLine,
    [
      { $match: { ledgerAccountId: account._id, partyId: objectId(employeeId) } },
      { $lookup: { from: 'journalentries', localField: 'journalEntryId', foreignField: '_id', as: 'entry' } },
      { $unwind: '$entry' },
      { $match: { 'entry.status': 'posted' } },
      { $group: { _id: null, debit: { $sum: '$debitPaise' }, credit: { $sum: '$creditPaise' } } },
    ],
    session,
  );
  return (row?.debit || 0) - (row?.credit || 0);
}

export function recordAdvance(salaryId, input, userId) {
  return runTxn(async (session) => {
    const salary = await SalaryRecord.findById(salaryId).session(session);
    if (!salary) throw new HttpError('Salary record not found', 404);
    if (salary.status === 'paid') throw new HttpError('This salary is already paid');
    const bank = await activeBank(session, input.bankAccountId);
    const advance = await accountByCode(session, '1300');
    await postEntry({
      session,
      dateKey: input.dateKey,
      memo: `Salary advance · ${salary.monthKey}`,
      sourceType: 'salary_advance',
      sourceId: salary._id,
      lines: [
        { accountId: advance._id, debitPaise: input.amountPaise, partyType: 'employee', partyId: salary.employeeId },
        { accountId: bank.ledgerAccountId, creditPaise: input.amountPaise },
      ],
      idempotencyKey: input.idempotencyKey,
      userId,
      method: input.paymentMethod,
    });
    return { salary, advanceBalancePaise: await advanceBalance(salary.employeeId, session) };
  });
}

export function paySalary(salaryId, input, userId) {
  return runTxn(async (session) => {
    const salary = await SalaryRecord.findById(salaryId).session(session);
    if (!salary) throw new HttpError('Salary record not found', 404);
    if (salary.status === 'paid') throw new HttpError('This salary month is already paid');
    if (salary.paymentIdempotencyKey && salary.paymentIdempotencyKey === input.idempotencyKey) return salary;
    const gross = salary.basePaise + salary.bonusPaise - salary.deductionPaise;
    if (gross <= 0) throw new HttpError('Final salary must be greater than zero');
    const recovery = input.advanceRecoveryPaise || 0;
    const net = gross - recovery;
    if (net > 0 && !input.bankAccountId) throw new HttpError('Choose the account that will pay this salary');
    const availableAdvance = await advanceBalance(salary.employeeId, session);
    if (recovery > availableAdvance) throw new HttpError('Advance recovery is higher than the outstanding advance');
    if (recovery > gross) throw new HttpError('Advance recovery cannot exceed the salary');
    const employeeModel = mongoose.model('Employee');
    const employee = await employeeModel.findById(salary.employeeId).session(session);
    const salaryAccount = await accountByCode(session, '5020');
    const lines = [{ accountId: salaryAccount._id, debitPaise: gross, partyType: 'employee', partyId: employee._id }];
    let bank;
    if (recovery > 0) {
      const advance = await accountByCode(session, '1300');
      lines.push({ accountId: advance._id, creditPaise: recovery, partyType: 'employee', partyId: employee._id });
    }
    if (net > 0) {
      bank = await activeBank(session, input.bankAccountId);
      lines.push({ accountId: bank.ledgerAccountId, creditPaise: net });
    }
    const posted = await postEntry({
      session,
      dateKey: input.dateKey,
      memo: `Salary · ${employee.fullName} · ${salary.monthKey}`,
      sourceType: 'salary',
      sourceId: salary._id,
      lines,
      idempotencyKey: input.idempotencyKey,
      userId,
      method: input.paymentMethod,
      counterparty: employee.fullName,
    });
    const [expense] = await Expense.create(
      [
        {
          title: `Salary · ${employee.fullName} · ${salary.monthKey}`,
          amountPaise: gross,
          category: 'Employee Salary',
          dateKey: input.dateKey,
          paidByType: 'company',
          bankAccountId: bank?._id,
          paymentMethod: input.paymentMethod,
          description: 'Posted from salary payment',
          linkedSalaryId: salary._id,
          journalEntryId: posted.entry._id,
          reference: posted.reference,
          idempotencyKey: `salary-expense:${salary._id}:${input.idempotencyKey}`,
          recordedBy: userId,
          voided: false,
        },
      ],
      { session },
    );
    salary.status = 'paid';
    salary.advanceRecoveryPaise = recovery;
    salary.netPaise = net;
    salary.paidDate = input.dateKey;
    salary.bankAccountId = bank?._id;
    salary.paymentMethod = input.paymentMethod;
    salary.journalEntryId = posted.entry._id;
    salary.expenseId = expense._id;
    salary.paymentIdempotencyKey = input.idempotencyKey;
    await salary.save({ session });
    return salary;
  });
}

export function postManualJournal(input, userId) {
  return runTxn(async (session) => {
    const lines = [];
    for (const line of input.lines) {
      const account = await LedgerAccount.findById(line.accountId).session(session);
      if (!account) throw new HttpError('Unknown ledger account');
      lines.push({
        accountId: account._id,
        debitPaise: line.debitPaise || 0,
        creditPaise: line.creditPaise || 0,
        memo: line.memo,
      });
    }
    return postEntry({
      session,
      dateKey: input.dateKey,
      memo: input.memo,
      sourceType: 'manual',
      lines,
      idempotencyKey: input.idempotencyKey,
      userId,
    });
  });
}

export function voidFinancial(entryId, userId, reason, dateKey) {
  return runTxn(async (session) => {
    const entry = await JournalEntry.findById(entryId).session(session);
    if (!entry) throw new HttpError('Journal entry not found', 404);
    const reversal = await reverseEntry({ session, entryId, userId, reason, dateKey });
    if (!reversal.reused) await applyVoid(session, entry, userId, reason, dateKey);
    return reversal;
  });
}

async function applyVoid(session, entry, userId, reason, dateKey) {
  if (entry.sourceType === 'income') {
    await Income.updateOne({ _id: entry.sourceId }, { voided: true }, { session });
  } else if (entry.sourceType === 'expense') {
    const expense = await Expense.findById(entry.sourceId).session(session);
    if (expense) {
      expense.voided = true;
      expense.recurrenceActive = false;
      expense.nextRunDate = undefined;
      await expense.save({ session });
      if (expense.linkedSalaryId) await unpaySalary(session, expense.linkedSalaryId);
    }
  } else if (entry.sourceType === 'founder_contribution') {
    await FounderContribution.updateOne({ _id: entry.sourceId }, { voided: true }, { session });
  } else if (entry.sourceType === 'founder_withdrawal') {
    await FounderWithdrawal.updateOne({ _id: entry.sourceId }, { voided: true }, { session });
  } else if (entry.sourceType === 'profit_distribution' || entry.sourceType === 'profit_payout') {
    const distribution = await ProfitDistribution.findById(entry.sourceId).session(session);
    if (!distribution || distribution.voided) return;
    if (entry.sourceType === 'profit_payout') {
      await FounderWithdrawal.updateMany({ distributionId: distribution._id }, { voided: true }, { session });
      distribution.payout = false;
      await distribution.save({ session });
      return;
    }
    if (distribution.payoutJournalEntryId) {
      const payout = await JournalEntry.findById(distribution.payoutJournalEntryId).session(session);
      if (payout?.status === 'posted') {
        await reverseEntry({ session, entryId: payout._id, userId, reason, dateKey });
        await FounderWithdrawal.updateMany({ distributionId: distribution._id }, { voided: true }, { session });
      }
    }
    distribution.voided = true;
    await distribution.save({ session });
  } else if (entry.sourceType === 'invoice') {
    const invoice = await Invoice.findById(entry.sourceId).session(session);
    if (invoice.amountPaidPaise > 0) throw new HttpError('Reverse the invoice receipts before cancelling it');
    invoice.status = 'cancelled';
    await invoice.save({ session });
  } else if (entry.sourceType === 'salary') {
    await unpaySalary(session, entry.sourceId);
    await Expense.updateOne({ linkedSalaryId: entry.sourceId, voided: false }, { voided: true, recurrenceActive: false }, { session });
  } else if (entry.sourceType === 'client_receipt') {
    const payment = await ClientPayment.findById(entry.sourceId).session(session);
    const receipt = payment?.receipts.id(entry.sourceSubId);
    if (payment && receipt && !receipt.reversed) {
      receipt.reversed = true;
      payment.amountReceivedPaise = Math.max(0, payment.amountReceivedPaise - receipt.amountPaise);
      const today = todayKey((await getSettings()).timezone);
      payment.status = paymentStatus(payment.invoiceAmountPaise, payment.amountReceivedPaise, payment.dueDate, today);
      await payment.save({ session });
      await Income.updateOne({ idempotencyKey: `receipt:${receipt._id}` }, { $set: { voided: true } }, { session });
      if (payment.invoiceId) await reverseInvoiceReceipt(session, payment.invoiceId, receipt.journalEntryId, today);
    }
  } else if (entry.sourceType === 'invoice_receipt') {
    const today = todayKey((await getSettings()).timezone);
    await reverseInvoiceReceipt(session, entry.sourceId, entry._id, today);
  }
}

async function reverseInvoiceReceipt(session, invoiceId, journalEntryId, today) {
  const invoice = await Invoice.findById(invoiceId).session(session);
  if (!invoice) return;
  const receipt = invoice.receipts.find((item) => String(item.journalEntryId) === String(journalEntryId) && !item.reversed);
  if (!receipt) return;
  receipt.reversed = true;
  invoice.amountPaidPaise = Math.max(0, invoice.amountPaidPaise - receipt.amountPaise);
  invoice.status = invoiceStatus(invoice, today);
  await invoice.save({ session });
}

async function unpaySalary(session, salaryId) {
  const salary = await SalaryRecord.findById(salaryId).session(session);
  if (!salary || salary.status !== 'paid') return;
  salary.status = 'draft';
  salary.netPaise = 0;
  salary.advanceRecoveryPaise = 0;
  salary.paidDate = undefined;
  salary.paymentIdempotencyKey = undefined;
  salary.journalEntryId = undefined;
  await salary.save({ session });
}

async function commitOnce(model, key, work) {
  const existing = await existingIdempotent(model, key);
  if (existing) return existing;
  try {
    return await runTxn(work);
  } catch (error) {
    if (error?.code === 11000 && error.keyPattern?.idempotencyKey && key) {
      const replay = await model.findOne({ idempotencyKey: key });
      if (replay) return replay;
    }
    throw error;
  }
}

export { paymentStatus, invoiceStatus, profitBetween };
