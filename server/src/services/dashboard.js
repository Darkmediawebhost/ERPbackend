import { eachMonth, previousWindow } from '../dates.js';
import { HttpError } from '../errors.js';
import {
  Attendance,
  BankAccount,
  CalendarEvent,
  Client,
  ClientPayment,
  CoFounder,
  JournalLine,
  Project,
  StickyNote,
  Task,
  Transaction,
} from '../models.js';
import { hasPerm } from '../auth.js';
import { founderParts, profitBetween, refreshOverdues } from './finance.js';

export async function buildDashboard(user, range) {
  await refreshOverdues();
  if (!hasPerm(user, 'income.view') && !hasPerm(user, 'reports.view')) {
    return operationsDashboard(user, range);
  }

  const match = { 'entry.status': 'posted', 'entry.dateKey': { $gte: range.from, $lte: range.to } };
  const prior = previousWindow(range.from, range.to);
  const [profit, previous, months, categoryRows, flowRows, banks, founders, pending, clientCount, activeProjects, recentTransactions, upcomingPayments, recentClients, upcomingEvents, pendingTasks, notes, deadlines] = await Promise.all([
    profitBetween(range.from, range.to),
    profitBetween(prior.from, prior.to),
    Promise.resolve(eachMonth(range.from, range.to)),
    JournalLine.aggregate([
      { $lookup: { from: 'journalentries', localField: 'journalEntryId', foreignField: '_id', as: 'entry' } },
      { $unwind: '$entry' },
      { $match: match },
      { $lookup: { from: 'ledgeraccounts', localField: 'ledgerAccountId', foreignField: '_id', as: 'account' } },
      { $unwind: '$account' },
      { $match: { 'account.type': { $in: ['income', 'expense'] } } },
      {
        $group: {
          _id: { month: { $substr: ['$entry.dateKey', 0, 7] }, type: '$account.type', name: '$account.name' },
          debit: { $sum: '$debitPaise' },
          credit: { $sum: '$creditPaise' },
        },
      },
    ]),
    Transaction.aggregate([
      { $match: { bookStatus: 'posted', dateKey: { $gte: range.from, $lte: range.to } } },
      { $group: { _id: { month: { $substr: ['$dateKey', 0, 7] }, direction: '$direction' }, total: { $sum: '$amountPaise' } } },
    ]),
    BankAccount.find({ status: 'active' }),
    CoFounder.find().sort({ fullName: 1 }),
    ClientPayment.aggregate([
      { $match: { voided: false, status: { $in: ['pending', 'partial', 'overdue'] } } },
      { $group: { _id: null, total: { $sum: { $subtract: ['$invoiceAmountPaise', '$amountReceivedPaise'] } }, count: { $sum: 1 } } },
    ]),
    Client.countDocuments({ status: 'active' }),
    Project.countDocuments({ status: { $in: ['Planning', 'Not Started', 'In Progress', 'Review', 'On Hold'] } }),
    Transaction.find({ bookStatus: 'posted' }).sort({ dateKey: -1, createdAt: -1 }).limit(8).populate('bankAccountId', 'accountName'),
    ClientPayment.find({ voided: false, status: { $in: ['pending', 'partial', 'overdue'] } }).sort({ dueDate: 1 }).limit(6).populate('clientId', 'name companyName'),
    Client.find().sort({ createdAt: -1 }).limit(5),
    CalendarEvent.find({ dateKey: { $gte: range.from } }).sort({ dateKey: 1, startTime: 1 }).limit(6),
    Task.find({ status: { $ne: 'Completed' } }).sort({ dueDate: 1 }).limit(6).populate('projectId', 'name'),
    visibleNotes(user),
    Project.find({ status: { $ne: 'Completed' }, dueDate: { $gte: range.from, $lte: range.to } }).sort({ dueDate: 1 }).limit(6).populate('clientId', 'name'),
  ]);

  const monthMap = new Map(months.map((month) => [month, { month, incomePaise: 0, expensePaise: 0 }]));
  const categories = new Map();
  for (const row of categoryRows) {
    const amount = row._id.type === 'income' ? row.credit - row.debit : row.debit - row.credit;
    const bucket = monthMap.get(row._id.month);
    if (bucket) {
      if (row._id.type === 'income') bucket.incomePaise += amount;
      else bucket.expensePaise += amount;
    }
    if (row._id.type === 'income' || row._id.type === 'expense') {
      const key = `${row._id.type}:${row._id.name}`;
      const current = categories.get(key) || { type: row._id.type, name: row._id.name, amountPaise: 0 };
      current.amountPaise += amount;
      categories.set(key, current);
    }
  }
  const series = [...monthMap.values()].map((row) => ({ ...row, netPaise: row.incomePaise - row.expensePaise }));
  const flow = months.map((month) => {
    const inflow = flowRows.find((row) => row._id.month === month && row._id.direction === 'in')?.total || 0;
    const outflow = flowRows.find((row) => row._id.month === month && row._id.direction === 'out')?.total || 0;
    return { month, inPaise: inflow, outPaise: outflow, netPaise: inflow - outflow };
  });
  const founderAnalytics = await Promise.all(founders.map(async (founder) => {
    const parts = await founderParts(founder._id);
    return {
      id: founder._id,
      name: founder.fullName,
      capitalPaise: parts.ledgerBalancePaise,
      withdrawalsPaise: parts.withdrawalsPaise,
      profitPaise: parts.profitPaise,
      reimbursementDuePaise: parts.reimbursementDuePaise,
      reconciled: parts.reconciled,
    };
  }));
  const completedProjects = await Project.countDocuments({ status: 'Completed', ...(range.from ? { updatedAt: { $gte: new Date(`${range.from}T00:00:00+05:30`) } } : {}) });

  return {
    mode: 'finance',
    range,
    growthBps: previous.incomePaise === 0 ? null : Math.round(((profit.incomePaise - previous.incomePaise) * 10000) / previous.incomePaise),
    previousIncomePaise: previous.incomePaise,
    stats: {
      incomePaise: profit.incomePaise,
      expensePaise: profit.expensePaise,
      netProfitPaise: profit.netPaise,
      bankBalancePaise: sumAccounts(banks, ['bank', 'online', 'business']),
      bankAccountCount: banks.filter((bank) => ['bank', 'online', 'business'].includes(bank.accountType)).length,
      cashBalancePaise: sumAccounts(banks, ['cash']),
      pendingPaymentsPaise: pending[0]?.total || 0,
      pendingPaymentCount: pending[0]?.count || 0,
      clientCount,
      activeProjects,
      founderCapitalPaise: founderAnalytics.reduce((sum, founder) => sum + founder.capitalPaise, 0),
      monthlyRevenuePaise: profit.incomePaise,
    },
    revenueAnalytics: series,
    incomeVsExpense: series,
    incomeByCategory: [...categories.values()].filter((row) => row.type === 'income' && row.amountPaise !== 0),
    expenseByCategory: [...categories.values()].filter((row) => row.type === 'expense' && row.amountPaise !== 0),
    cashFlow: flow,
    profitAndLoss: { revenuePaise: profit.incomePaise, operatingExpensesPaise: profit.expensePaise, netProfitPaise: profit.netPaise },
    clientAnalytics: { active: clientCount, completedProjects, pendingPaymentsPaise: pending[0]?.total || 0, pendingCount: pending[0]?.count || 0 },
    founderAnalytics,
    recentTransactions,
    upcomingPayments,
    recentClients,
    upcomingEvents,
    pendingTasks,
    notes,
    deadlines,
  };
}

function sumAccounts(banks, types) {
  return banks.filter((bank) => types.includes(bank.accountType)).reduce((sum, bank) => sum + bank.currentBalancePaise, 0);
}

async function visibleNotes(user) {
  return StickyNote.find({
    pinned: true,
    $or: [{ visibility: 'company' }, { ownerId: user._id }],
  }).sort({ updatedAt: -1 }).limit(6);
}

async function operationsDashboard(user, range) {
  const today = range.to;
  const [tasks, events, notes, attendance] = await Promise.all([
    Task.find({ status: { $ne: 'Completed' }, ...(user.employeeId ? {} : {}) }).sort({ dueDate: 1 }).limit(8).populate('projectId', 'name'),
    CalendarEvent.find({ dateKey: { $gte: today } }).sort({ dateKey: 1 }).limit(6),
    visibleNotes(user),
    user.employeeId ? Attendance.findOne({ employeeId: user.employeeId, dateKey: today }) : null,
  ]);
  return { mode: 'operations', range, tasks, events, notes, attendance };
}

const SOURCE_LABEL = {
  income: 'Income',
  expense: 'Expense',
  client_receipt: 'Client payment',
  invoice: 'Invoice',
  invoice_receipt: 'Invoice receipt',
  salary: 'Salary',
  salary_advance: 'Salary advance',
  founder_contribution: 'Contribution',
  founder_withdrawal: 'Withdrawal',
  profit_distribution: 'Profit share',
  profit_payout: 'Profit payout',
  bank_transfer: 'Transfer',
  opening_balance: 'Opening balance',
  manual: 'Journal',
  reversal: 'Reversal',
};

const PAYMENT_GROUP = { pending: 'Pending', partial: 'Part paid', overdue: 'Overdue' };

export async function buildBreakdown(metric, range) {
  if (metric === 'income' || metric === 'revenue') return ledgerBreakdown(metric, range, 'income');
  if (metric === 'expenses') return ledgerBreakdown(metric, range, 'expense');
  if (metric === 'profit') return profitBreakdown(range);
  if (metric === 'banks') return accountBreakdown('banks', range, ['bank', 'online', 'business']);
  if (metric === 'cash') return accountBreakdown('cash', range, ['cash']);
  if (metric === 'payments') return paymentBreakdown(range);
  if (metric === 'clients') return clientBreakdown(range);
  if (metric === 'projects') return projectBreakdown(range);
  if (metric === 'capital') return capitalBreakdown(range);
  throw new HttpError('That dashboard item does not open a list', 404);
}

async function ledgerBreakdown(metric, range, accountType) {
  const profit = await profitBetween(range.from, range.to);
  const rows = await ledgerLines(range, accountType, true);
  const totalPaise = accountType === 'income' ? profit.incomePaise : profit.expensePaise;
  const title = metric === 'revenue' ? 'Revenue' : accountType === 'income' ? 'Total income' : 'Total expenses';
  const text = accountType === 'income'
    ? 'Every posted income line in this period. The total matches the dashboard.'
    : 'Every posted expense line in this period. The total matches the dashboard.';
  return pack(metric, title, text, 'money', totalPaise, range, [
    { id: 'lines', title: 'Entries', kind: 'list', rows },
  ], true);
}

async function profitBreakdown(range) {
  const profit = await profitBetween(range.from, range.to);
  const [income, expenses] = await Promise.all([
    ledgerLines(range, 'income', false),
    ledgerLines(range, 'expense', false),
  ]);
  return pack('profit', 'Net profit', 'Income minus expenses for this period. Open a line to see where it was recorded.', 'money', profit.netPaise, range, [
    { id: 'income', title: 'Income', kind: 'list', rows: income },
    { id: 'expenses', title: 'Expenses', kind: 'list', rows: expenses },
  ]);
}

async function accountBreakdown(metric, range, types) {
  const banks = await BankAccount.find({ status: 'active', accountType: { $in: types } }).sort({ accountName: 1 }).lean();
  const ids = banks.map((bank) => bank._id);
  const movements = ids.length
    ? await Transaction.find({ bookStatus: 'posted', bankAccountId: { $in: ids } }).sort({ dateKey: -1, createdAt: -1 }).limit(500).populate('bankAccountId', 'accountName').lean()
    : [];
  const accounts = banks.map((bank) => ({
    id: String(bank._id),
    date: '',
    title: bank.accountName,
    detail: bank.accountType,
    group: bank.accountType,
    amountPaise: bank.currentBalancePaise,
    href: `/banks/${bank._id}`,
  }));
  const rows = movements.map((row) => ({
    id: String(row._id),
    date: row.dateKey,
    title: row.description || row.counterparty || 'Movement',
    detail: row.bankAccountId?.accountName || '',
    group: row.bankAccountId?.accountName || 'Account',
    amountPaise: row.direction === 'out' ? -row.amountPaise : row.amountPaise,
    href: `/banks/${row.bankAccountId?._id || row.bankAccountId}`,
  }));
  const totalPaise = accounts.reduce((sum, row) => sum + row.amountPaise, 0);
  const title = metric === 'cash' ? 'Cash balance' : 'Bank balance';
  const text = metric === 'cash'
    ? 'Current Company Cash. Movements below are every posted cash entry.'
    : 'Current balance of each bank. Movements below are every posted entry on those accounts.';
  return pack(metric, title, text, 'money', totalPaise, range, [
    { id: 'accounts', title: 'Accounts', kind: 'accounts', rows: accounts },
    { id: 'movements', title: 'Movements', kind: 'list', rows },
  ], false);
}

async function paymentBreakdown(range) {
  const payments = await ClientPayment.find({ voided: false, status: { $in: ['pending', 'partial', 'overdue'] } })
    .sort({ dueDate: 1, createdAt: -1 })
    .populate('clientId', 'name')
    .lean();
  const rows = payments.map((row) => ({
    id: String(row._id),
    date: row.dueDate || '',
    title: row.clientId?.name || 'Client',
    detail: row.paymentType || 'Payment',
    group: PAYMENT_GROUP[row.status] || 'Pending',
    amountPaise: row.invoiceAmountPaise - row.amountReceivedPaise,
    href: '/payments',
  }));
  const totalPaise = rows.reduce((sum, row) => sum + row.amountPaise, 0);
  return pack('payments', 'Pending payments', 'Open client payments. The amount is what is still unpaid.', 'money', totalPaise, range, [
    { id: 'payments', title: 'Open payments', kind: 'list', rows },
  ], false);
}

async function clientBreakdown(range) {
  const clients = await Client.find({ status: 'active' }).sort({ name: 1 }).lean();
  const rows = clients.map((row) => ({
    id: String(row._id),
    date: '',
    title: row.name,
    detail: [row.service, row.companyName].filter(Boolean).join(' · '),
    group: 'Active',
    amountPaise: row.monthlyAmountPaise || 0,
    href: `/clients/${row._id}`,
  }));
  return pack('clients', 'Clients', 'Active clients. A monthly fee is shown when the client is on a subscription.', 'count', clients.length, range, [
    { id: 'clients', title: 'Active clients', kind: 'list', rows },
  ], false);
}

async function projectBreakdown(range) {
  const projects = await Project.find({ status: { $in: ['Planning', 'Not Started', 'In Progress', 'Review', 'On Hold'] } })
    .sort({ dueDate: 1, name: 1 })
    .populate('clientId', 'name')
    .lean();
  const rows = projects.map((row) => ({
    id: String(row._id),
    date: row.dueDate || '',
    title: row.name,
    detail: `${row.clientId?.name || 'Client'} · ${row.status}`,
    group: row.status,
    amountPaise: 0,
    href: '/projects',
  }));
  return pack('projects', 'Projects', 'Projects that are still in motion.', 'count', projects.length, range, [
    { id: 'projects', title: 'In motion', kind: 'list', rows },
  ], false);
}

async function capitalBreakdown(range) {
  const founders = await CoFounder.find().sort({ fullName: 1 }).lean();
  const rows = [];
  for (const founder of founders) {
    const parts = await founderParts(founder._id);
    rows.push({
      id: String(founder._id),
      date: '',
      title: founder.fullName,
      detail: founder.designation || 'Co-founder',
      group: founder.accountStatus === 'active' ? 'Active' : 'Inactive',
      amountPaise: parts.ledgerBalancePaise,
      href: `/founders/${founder._id}`,
    });
  }
  const totalPaise = rows.reduce((sum, row) => sum + row.amountPaise, 0);
  return pack('capital', 'Co-founder capital', 'Ledger balance for each co-founder. Open a name to see contributions, withdrawals, and profit.', 'money', totalPaise, range, [
    { id: 'founders', title: 'Co-founders', kind: 'list', rows },
  ], false);
}

async function ledgerLines(range, accountType, groupByAccount) {
  const lines = await JournalLine.aggregate([
    { $lookup: { from: 'journalentries', localField: 'journalEntryId', foreignField: '_id', as: 'entry' } },
    { $unwind: '$entry' },
    { $match: { 'entry.status': 'posted', 'entry.dateKey': { $gte: range.from, $lte: range.to } } },
    { $lookup: { from: 'ledgeraccounts', localField: 'ledgerAccountId', foreignField: '_id', as: 'account' } },
    { $unwind: '$account' },
    { $match: { 'account.type': accountType } },
    { $sort: { 'entry.dateKey': -1, 'entry.entryNumber': -1 } },
  ]);
  const section = accountType === 'income' ? 'Income' : 'Expenses';
  return lines.flatMap((row) => {
    const amountPaise = accountType === 'income' ? row.creditPaise - row.debitPaise : row.debitPaise - row.creditPaise;
    if (!amountPaise) return [];
    const account = row.account.name;
    const memo = String(row.memo || row.entry.memo || account).trim();
    const source = SOURCE_LABEL[row.entry.sourceType] || 'Entry';
    return [{
      id: String(row._id),
      date: row.entry.dateKey,
      title: memo || account,
      detail: memo && memo !== account ? `${account} · ${source}` : source,
      group: groupByAccount ? account : section,
      amountPaise,
      href: sourceHref(row.entry.sourceType, row.entry.sourceId),
    }];
  });
}

function sourceHref(sourceType, sourceId) {
  const id = sourceId ? String(sourceId) : '';
  if (sourceType === 'invoice' && id) return `/invoices/${id}`;
  if (sourceType === 'client_receipt') return '/payments';
  if (sourceType === 'income') return '/income';
  if (sourceType === 'expense') return '/expenses';
  if (sourceType === 'salary' || sourceType === 'salary_advance') return '/salary';
  if (sourceType === 'founder_contribution' || sourceType === 'founder_withdrawal' || sourceType === 'profit_distribution' || sourceType === 'profit_payout') return '/founder-finance';
  if (sourceType === 'bank_transfer' || sourceType === 'opening_balance') return '/banks';
  return '';
}

function pack(metric, title, text, mode, total, range, sections, period = true) {
  return {
    metric,
    title,
    text,
    mode,
    period,
    totalPaise: mode === 'money' ? total : 0,
    total: mode === 'count' ? total : sections.filter((section) => section.kind === 'list').reduce((sum, section) => sum + section.rows.length, 0),
    range,
    sections,
  };
}
