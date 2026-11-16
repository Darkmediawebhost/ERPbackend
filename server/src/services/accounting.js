import mongoose from 'mongoose';
import { BankAccount, Counter, JournalEntry, JournalLine, LedgerAccount, Transaction } from '../models.js';
import { assertBalanced, assertFunds } from '../money.js';
import { dateFromKey, parseYmd } from '../dates.js';
import { HttpError } from '../errors.js';

export async function runTxn(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (error) {
    const message = String(error?.message || '');
    if (
      message.includes('replica set') ||
      message.includes('Transaction numbers are only allowed') ||
      message.includes('mongos')
    ) {
      throw new HttpError(
        'Financial writes need a MongoDB replica set. Use MongoDB Atlas or docker compose up.',
        503,
      );
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function nextNumber(session, key, prefix, pad = 5) {
  const year = new Date().getFullYear();
  const counterId = `${key}:${year}`;
  const counter = await Counter.findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session },
  );
  return `${prefix}-${year}-${String(counter.seq).padStart(pad, '0')}`;
}

export async function accountByCode(session, code) {
  const account = await LedgerAccount.findOne({ code }).session(session);
  if (!account || account.status !== 'active') {
    throw new HttpError(`Ledger account ${code} is not available`);
  }
  return account;
}

export async function activeBank(session, bankAccountId) {
  const bank = await BankAccount.findById(bankAccountId).session(session);
  if (!bank || bank.status !== 'active') throw new HttpError('Choose an active bank or cash account');
  if (!bank.ledgerAccountId) throw new HttpError('This account is not linked to the ledger');
  return bank;
}

export async function postEntry({
  session,
  dateKey,
  memo,
  sourceType,
  sourceId,
  sourceSubId,
  lines,
  idempotencyKey,
  userId,
  bookStatus = 'posted',
  reversalOf,
  method,
  counterparty,
}) {
  parseYmd(dateKey);
  if (idempotencyKey) {
    const existing = await JournalEntry.findOne({ idempotencyKey }).session(session);
    if (existing) {
      if (existing.status === 'reversed' || existing.status === 'reversal') {
        throw new HttpError('This submission was already reversed. Submit it again with a new reference key.', 409);
      }
      return { entry: existing, reference: existing.reference, reused: true };
    }
  }
  const total = assertBalanced(lines);
  const accountIds = [...new Set(lines.map((line) => String(line.accountId)))];
  const accounts = await LedgerAccount.find({ _id: { $in: accountIds } }).session(session);
  if (accounts.length !== accountIds.length) throw new HttpError('One of the ledger accounts does not exist');
  const accountsById = new Map(accounts.map((account) => [String(account._id), account]));

  const bankDeltas = new Map();
  for (const line of lines) {
    const account = accountsById.get(String(line.accountId));
    if (account.status !== 'active') throw new HttpError(`${account.name} is inactive`);
    if (!account.bankAccountId) continue;
    const delta = (line.debitPaise || 0) - (line.creditPaise || 0);
    bankDeltas.set(String(account.bankAccountId), (bankDeltas.get(String(account.bankAccountId)) || 0) + delta);
  }

  const banks = new Map();
  for (const [bankId, delta] of bankDeltas) {
    const bank = await BankAccount.findById(bankId).session(session);
    if (!bank || bank.status !== 'active') throw new HttpError('A linked bank account is inactive');
    if (delta === 0) continue;
    assertFunds(bank.currentBalancePaise, delta, bank.allowOverdraft, bank.accountName);
    banks.set(bankId, bank);
  }

  const entryNumber = await nextNumber(session, 'journal', 'JE');
  const reference = await nextNumber(session, 'txn', 'TXN');
  const [entry] = await JournalEntry.create(
    [
      {
        entryNumber,
        reference,
        dateKey,
        memo,
        sourceType,
        sourceId,
        sourceSubId,
        status: bookStatus,
        reversalOf,
        idempotencyKey,
        postedBy: userId,
        totalDebitPaise: total,
        totalCreditPaise: total,
      },
    ],
    { session },
  );

  await JournalLine.insertMany(
    lines.map((line) => ({
      journalEntryId: entry._id,
      ledgerAccountId: line.accountId,
      debitPaise: line.debitPaise || 0,
      creditPaise: line.creditPaise || 0,
      memo: line.memo || memo,
      partyType: line.partyType || '',
      partyId: line.partyId,
    })),
    { session },
  );

  let transactionIndex = 1;
  for (const [bankId, delta] of bankDeltas) {
    if (delta === 0) continue;
    const bank = banks.get(bankId);
    bank.currentBalancePaise += delta;
    await bank.save({ session });
    await Transaction.create(
      [
        {
          reference: `${reference}-${transactionIndex}`,
          dateKey,
          amountPaise: Math.abs(delta),
          direction: delta >= 0 ? 'in' : 'out',
          bankAccountId: bank._id,
          journalEntryId: entry._id,
          sourceType,
          sourceId,
          description: memo,
          method: method || '',
          counterparty: counterparty || '',
          bookStatus,
        },
      ],
      { session },
    );
    transactionIndex += 1;
  }

  return { entry, reference, reused: false };
}

export async function reverseEntry({ session, entryId, userId, reason, dateKey }) {
  const entry = await JournalEntry.findById(entryId).session(session);
  if (!entry) throw new HttpError('Journal entry not found', 404);
  if (entry.status !== 'posted') throw new HttpError('Only a posted entry can be reversed');
  const lines = await JournalLine.find({ journalEntryId: entry._id }).session(session);
  const reversal = await postEntry({
    session,
    dateKey: dateKey || entry.dateKey,
    memo: `Reversal of ${entry.entryNumber}${reason ? `: ${reason}` : ''}`,
    sourceType: 'reversal',
    sourceId: entry._id,
    userId,
    bookStatus: 'reversal',
    reversalOf: entry._id,
    idempotencyKey: `reverse:${entry._id}`,
    lines: lines.map((line) => ({
      accountId: line.ledgerAccountId,
      debitPaise: line.creditPaise,
      creditPaise: line.debitPaise,
      memo: `Reversal · ${line.memo || ''}`.trim(),
      partyType: line.partyType,
      partyId: line.partyId,
    })),
  });
  if (!reversal.reused) {
    entry.status = 'reversed';
    entry.reversedBy = reversal.entry._id;
    entry.reversalReason = reason || '';
    await entry.save({ session });
    await Transaction.updateMany({ journalEntryId: entry._id }, { $set: { bookStatus: 'reversed' } }, { session });
  }
  return reversal;
}

export async function ledgerNet(session, ledgerAccountId, untilDateKey) {
  const match = { ledgerAccountId: new mongoose.Types.ObjectId(String(ledgerAccountId)) };
  const pipeline = [
    { $match: match },
    {
      $lookup: {
        from: 'journalentries',
        localField: 'journalEntryId',
        foreignField: '_id',
        as: 'entry',
      },
    },
    { $unwind: '$entry' },
    { $match: { 'entry.status': 'posted', ...(untilDateKey ? { 'entry.dateKey': { $lte: untilDateKey } } : {}) } },
    { $group: { _id: null, debit: { $sum: '$debitPaise' }, credit: { $sum: '$creditPaise' } } },
  ];
  const query = JournalLine.aggregate(pipeline);
  if (session) query.session(session);
  const [row] = await query;
  return { debit: row?.debit || 0, credit: row?.credit || 0 };
}

export function signedBalance(account, debit, credit) {
  return account.normalBalance === 'debit' ? debit - credit : credit - debit;
}

export async function accountBalance(session, account, untilDateKey) {
  const nets = await ledgerNet(session, account._id, untilDateKey);
  return signedBalance(account, nets.debit, nets.credit);
}

export { dateFromKey };
