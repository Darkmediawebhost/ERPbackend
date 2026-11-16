import { addDays, eachMonth, monthEnd, monthStart, weekdayIndex } from '../dates.js';
import { HttpError } from '../errors.js';
import { formatBasisPoints, formatInr } from '../money.js';
import {
  Attendance,
  BankAccount,
  Client,
  ClientPayment,
  CoFounder,
  Employee,
  Expense,
  Income,
  Invoice,
  JournalEntry,
  JournalLine,
  LedgerAccount,
  ProfitDistribution,
  Project,
  SalaryRecord,
  Task,
  Transaction,
} from '../models.js';
import { accountBalance, signedBalance } from './accounting.js';
import { founderParts } from './finance.js';
import { getSettings } from '../settingsCache.js';

const money = true;

export async function buildReport(name, range, query) {
  const builders = {
    'profit-loss': profitAndLoss,
    income: incomeReport,
    expense: expenseReport,
    'cash-flow': cashFlow,
    'bank-statement': bankStatement,
    'balance-sheet': balanceSheet,
    'trial-balance': trialBalance,
    'general-ledger': generalLedger,
    receivables: receivables,
    payables: payables,
    'founder-capital': founderCapital,
    'profit-distribution': distributions,
    clients: clients,
    projects: projects,
    tasks: taskReport,
    attendance: attendanceReport,
    salary: salaryReport,
    invoices: invoiceReport,
  };
  const builder = builders[name];
  if (!builder) throw new HttpError('Unknown report', 404);
  const report = await builder(range, query);
  return { name, range, ...report };
}

async function totals(until) {
  return JournalLine.aggregate([
    { $lookup: { from: 'journalentries', localField: 'journalEntryId', foreignField: '_id', as: 'entry' } },
    { $unwind: '$entry' },
    { $match: { 'entry.status': 'posted', ...(until ? { 'entry.dateKey': { $lte: until } } : {}) } },
    { $group: { _id: '$ledgerAccountId', debit: { $sum: '$debitPaise' }, credit: { $sum: '$creditPaise' } } },
  ]);
}

async function profitAndLoss(range, query) {
  const rows = await JournalLine.aggregate([
    { $lookup: { from: 'journalentries', localField: 'journalEntryId', foreignField: '_id', as: 'entry' } },
    { $unwind: '$entry' },
    { $match: { 'entry.status': 'posted', 'entry.dateKey': { $gte: range.from, $lte: range.to } } },
    { $lookup: { from: 'ledgeraccounts', localField: 'ledgerAccountId', foreignField: '_id', as: 'account' } },
    { $unwind: '$account' },
    { $match: { 'account.type': { $in: ['income', 'expense'] }, ...(query.category ? { 'account.name': query.category } : {}) } },
    { $group: { _id: { type: '$account.type', name: '$account.name' }, debit: { $sum: '$debitPaise' }, credit: { $sum: '$creditPaise' } } },
    { $sort: { '_id.type': 1, '_id.name': 1 } },
  ]);
  const data = rows.map((row) => ({
    section: row._id.type === 'income' ? 'Income' : 'Expenses',
    account: row._id.name,
    amountPaise: row._id.type === 'income' ? row.credit - row.debit : row.debit - row.credit,
  })).filter((row) => row.amountPaise !== 0);
  const incomePaise = data.filter((row) => row.section === 'Income').reduce((sum, row) => sum + row.amountPaise, 0);
  const expensePaise = data.filter((row) => row.section === 'Expenses').reduce((sum, row) => sum + row.amountPaise, 0);
  data.push({ section: 'Net', account: 'Net profit', amountPaise: incomePaise - expensePaise });
  return {
    title: 'Profit and loss',
    columns: [
      { key: 'section', header: 'Section' },
      { key: 'account', header: 'Account' },
      { key: 'amountPaise', header: 'Amount (INR)', money, width: 18 },
    ],
    rows: data,
  };
}

async function incomeReport(range, query) {
  const filter = { voided: false, dateKey: { $gte: range.from, $lte: range.to } };
  if (query.category) filter.category = query.category;
  if (query.clientId) filter.clientId = query.clientId;
  const records = await Income.find(filter).sort({ dateKey: -1 }).populate('clientId', 'name').populate('bankAccountId', 'accountName');
  return {
    title: 'Income register',
    columns: [
      { key: 'date', header: 'Date' },
      { key: 'title', header: 'Title', width: 32 },
      { key: 'category', header: 'Category' },
      { key: 'client', header: 'Client' },
      { key: 'account', header: 'Account' },
      { key: 'amountPaise', header: 'Amount (INR)', money },
    ],
    rows: records.map((row) => ({
      date: row.dateKey,
      title: row.title,
      category: row.category,
      client: row.clientId?.name || '',
      account: row.bankAccountId?.accountName || '',
      amountPaise: row.amountPaise,
    })),
  };
}

async function expenseReport(range, query) {
  const filter = { voided: false, dateKey: { $gte: range.from, $lte: range.to } };
  if (query.category) filter.category = query.category;
  const records = await Expense.find(filter).sort({ dateKey: -1 }).populate('bankAccountId', 'accountName').populate('paidByFounderId', 'fullName');
  return {
    title: 'Expense register',
    columns: [
      { key: 'date', header: 'Date' },
      { key: 'title', header: 'Title', width: 32 },
      { key: 'category', header: 'Category' },
      { key: 'paidBy', header: 'Paid by' },
      { key: 'amountPaise', header: 'Amount (INR)', money },
    ],
    rows: records.map((row) => ({
      date: row.dateKey,
      title: row.title,
      category: row.category,
      paidBy: row.paidByType === 'founder' ? row.paidByFounderId?.fullName || 'Co-founder' : row.bankAccountId?.accountName || 'Company',
      amountPaise: row.amountPaise,
    })),
  };
}

async function cashFlow(range) {
  const months = eachMonth(range.from, range.to);
  const rows = await Transaction.aggregate([
    { $match: { bookStatus: 'posted', dateKey: { $gte: range.from, $lte: range.to } } },
    { $group: { _id: { month: { $substr: ['$dateKey', 0, 7] }, direction: '$direction' }, total: { $sum: '$amountPaise' } } },
  ]);
  return {
    title: 'Cash flow',
    columns: [
      { key: 'month', header: 'Month' },
      { key: 'inPaise', header: 'Money in (INR)', money },
      { key: 'outPaise', header: 'Money out (INR)', money },
      { key: 'netPaise', header: 'Net (INR)', money },
    ],
    rows: months.map((month) => {
      const inflow = rows.find((row) => row._id.month === month && row._id.direction === 'in')?.total || 0;
      const outflow = rows.find((row) => row._id.month === month && row._id.direction === 'out')?.total || 0;
      return { month, inPaise: inflow, outPaise: outflow, netPaise: inflow - outflow };
    }),
  };
}

async function bankStatement(range, query) {
  if (!query.accountId) throw new HttpError('Choose a bank account');
  const bank = await BankAccount.findById(query.accountId);
  if (!bank) throw new HttpError('Account not found', 404);
  const statement = await accountStatement(bank.ledgerAccountId, range.from, range.to);
  return {
    title: `Statement · ${bank.accountName}`,
    columns: [
      { key: 'date', header: 'Date' },
      { key: 'reference', header: 'Reference' },
      { key: 'memo', header: 'Memo', width: 40 },
      { key: 'debitPaise', header: 'Debit (INR)', money },
      { key: 'creditPaise', header: 'Credit (INR)', money },
      { key: 'balancePaise', header: 'Balance (INR)', money },
    ],
    rows: [
      { date: range.from, reference: '', memo: 'Opening balance', debitPaise: 0, creditPaise: 0, balancePaise: statement.openingPaise },
      ...statement.rows,
    ],
  };
}

export async function accountStatement(accountId, from, to) {
  const account = await LedgerAccount.findById(accountId);
  if (!account) throw new HttpError('Ledger account not found', 404);
  const [prior] = await JournalLine.aggregate([
    { $match: { ledgerAccountId: account._id } },
    { $lookup: { from: 'journalentries', localField: 'journalEntryId', foreignField: '_id', as: 'entry' } },
    { $unwind: '$entry' },
    { $match: { 'entry.status': 'posted', 'entry.dateKey': { $lt: from } } },
    { $group: { _id: null, debit: { $sum: '$debitPaise' }, credit: { $sum: '$creditPaise' } } },
  ]);
  let running = signedBalance(account, prior?.debit || 0, prior?.credit || 0);
  const openingPaise = running;
  const lines = await JournalLine.aggregate([
    { $match: { ledgerAccountId: account._id } },
    { $lookup: { from: 'journalentries', localField: 'journalEntryId', foreignField: '_id', as: 'entry' } },
    { $unwind: '$entry' },
    { $match: { 'entry.status': 'posted', 'entry.dateKey': { $gte: from, $lte: to } } },
    { $sort: { 'entry.dateKey': 1, 'entry.entryNumber': 1 } },
  ]);
  const rows = lines.map((line) => {
    const delta = account.normalBalance === 'debit' ? line.debitPaise - line.creditPaise : line.creditPaise - line.debitPaise;
    running += delta;
    return {
      date: line.entry.dateKey,
      reference: line.entry.reference,
      entryNumber: line.entry.entryNumber,
      memo: line.memo || line.entry.memo,
      debitPaise: line.debitPaise,
      creditPaise: line.creditPaise,
      balancePaise: running,
      journalEntryId: line.entry._id,
    };
  });
  return { account, openingPaise, closingPaise: running, rows };
}

async function balanceSheet(range) {
  const grouped = await totals(range.to);
  const accounts = await LedgerAccount.find({ status: 'active' });
  const byId = new Map(grouped.map((row) => [String(row._id), row]));
  const rows = [];
  let assets = 0;
  let liabilities = 0;
  let equity = 0;
  let earnings = 0;
  for (const account of accounts) {
    const total = byId.get(String(account._id)) || { debit: 0, credit: 0 };
    const balance = signedBalance(account, total.debit, total.credit);
    if (account.type === 'income') earnings += total.credit - total.debit;
    else if (account.type === 'expense') earnings -= total.debit - total.credit;
    else if (balance !== 0) {
      rows.push({ section: labelType(account.type), code: account.code, account: account.name, amountPaise: balance });
      if (account.type === 'asset') assets += balance;
      if (account.type === 'liability') liabilities += balance;
      if (account.type === 'equity') equity += balance;
    }
  }
  rows.push({ section: 'Equity', code: '', account: 'Current earnings', amountPaise: earnings });
  const balanced = assets === liabilities + equity + earnings;
  rows.push({ section: 'Check', code: '', account: balanced ? 'Balanced' : 'Out of balance', amountPaise: assets - (liabilities + equity + earnings) });
  return {
    title: `Balance sheet as of ${range.to}`,
    columns: [
      { key: 'section', header: 'Section' },
      { key: 'code', header: 'Code' },
      { key: 'account', header: 'Account', width: 36 },
      { key: 'amountPaise', header: 'Amount (INR)', money },
    ],
    rows,
  };
}

async function trialBalance(range) {
  const grouped = await totals(range.to);
  const accounts = await LedgerAccount.find().sort({ code: 1 });
  const byId = new Map(grouped.map((row) => [String(row._id), row]));
  const rows = accounts.map((account) => {
    const total = byId.get(String(account._id)) || { debit: 0, credit: 0 };
    return { code: account.code, account: account.name, type: account.type, debitPaise: total.debit, creditPaise: total.credit };
  }).filter((row) => row.debitPaise || row.creditPaise);
  const debit = rows.reduce((sum, row) => sum + row.debitPaise, 0);
  const credit = rows.reduce((sum, row) => sum + row.creditPaise, 0);
  rows.push({ code: '', account: 'Total', type: '', debitPaise: debit, creditPaise: credit });
  return {
    title: `Trial balance as of ${range.to}`,
    columns: [
      { key: 'code', header: 'Code' },
      { key: 'account', header: 'Account', width: 36 },
      { key: 'type', header: 'Type' },
      { key: 'debitPaise', header: 'Debit (INR)', money },
      { key: 'creditPaise', header: 'Credit (INR)', money },
    ],
    rows,
  };
}

async function generalLedger(range, query) {
  if (!query.accountId) throw new HttpError('Choose a ledger account');
  const statement = await accountStatement(query.accountId, range.from, range.to);
  return {
    title: `General ledger · ${statement.account.code} ${statement.account.name}`,
    columns: [
      { key: 'date', header: 'Date' },
      { key: 'reference', header: 'Reference' },
      { key: 'memo', header: 'Memo', width: 40 },
      { key: 'debitPaise', header: 'Debit (INR)', money },
      { key: 'creditPaise', header: 'Credit (INR)', money },
      { key: 'balancePaise', header: 'Balance (INR)', money },
    ],
    rows: statement.rows,
  };
}

async function receivables() {
  const invoices = await Invoice.find({ status: { $in: ['sent', 'partial', 'overdue'] } }).populate('clientId', 'name');
  const schedules = await ClientPayment.find({ voided: false, invoiceId: null, status: { $in: ['pending', 'partial', 'overdue'] } }).populate('clientId', 'name');
  const rows = [
    ...invoices.map((invoice) => ({
      kind: 'Invoice',
      party: invoice.clientId?.name || '',
      reference: invoice.number,
      due: invoice.dueDate,
      outstandingPaise: invoice.totalPaise - invoice.amountPaidPaise,
    })),
    ...schedules.map((payment) => ({
      kind: 'Schedule',
      party: payment.clientId?.name || '',
      reference: `${payment.paymentType} ${payment.periodKey}`,
      due: payment.dueDate,
      outstandingPaise: payment.invoiceAmountPaise - payment.amountReceivedPaise,
    })),
  ];
  return {
    title: 'Client receivables',
    columns: [
      { key: 'kind', header: 'Kind' },
      { key: 'party', header: 'Client' },
      { key: 'reference', header: 'Reference' },
      { key: 'due', header: 'Due' },
      { key: 'outstandingPaise', header: 'Outstanding (INR)', money },
    ],
    rows,
  };
}

async function payables() {
  const salaries = await SalaryRecord.find({ status: 'draft' }).populate('employeeId', 'fullName');
  const founders = await CoFounder.find({ accountStatus: 'active' });
  const rows = salaries.map((salary) => ({
    kind: 'Salary',
    party: salary.employeeId?.fullName || '',
    reference: salary.monthKey,
    amountPaise: Math.max(0, salary.basePaise + salary.bonusPaise - salary.deductionPaise),
  }));
  for (const founder of founders) {
    const parts = await founderParts(founder._id);
    if (parts.reimbursementDuePaise > 0) {
      rows.push({ kind: 'Reimbursement', party: founder.fullName, reference: 'Personal expenses', amountPaise: parts.reimbursementDuePaise });
    }
  }
  return {
    title: 'Payables',
    columns: [
      { key: 'kind', header: 'Kind' },
      { key: 'party', header: 'Party' },
      { key: 'reference', header: 'Reference' },
      { key: 'amountPaise', header: 'Amount (INR)', money },
    ],
    rows,
  };
}

async function founderCapital() {
  const founders = await CoFounder.find().sort({ fullName: 1 });
  const rows = [];
  for (const founder of founders) {
    const parts = await founderParts(founder._id);
    rows.push({
      name: founder.fullName,
      status: founder.accountStatus,
      ownership: formatBasisPoints(founder.ownershipBps),
      profitShare: formatBasisPoints(founder.profitShareBps),
      investedPaise: parts.investedPaise,
      personalExpensesPaise: parts.personalExpensesPaise,
      reimbursementsPaise: parts.reimbursementsPaise,
      withdrawalsPaise: parts.withdrawalsPaise,
      profitPaise: parts.profitPaise,
      lossPaise: parts.lossPaise,
      capitalPaise: parts.ledgerBalancePaise,
    });
  }
  return {
    title: 'Co-founder capital',
    columns: [
      { key: 'name', header: 'Co-founder' },
      { key: 'status', header: 'Status' },
      { key: 'ownership', header: 'Ownership %' },
      { key: 'profitShare', header: 'Profit share %' },
      { key: 'investedPaise', header: 'Invested (INR)', money },
      { key: 'withdrawalsPaise', header: 'Withdrawals (INR)', money },
      { key: 'profitPaise', header: 'Profit (INR)', money },
      { key: 'lossPaise', header: 'Loss (INR)', money },
      { key: 'capitalPaise', header: 'Capital (INR)', money },
    ],
    rows,
  };
}

async function distributions(range) {
  const records = await ProfitDistribution.find({
    voided: false,
    periodStartKey: { $lte: range.to },
    periodEndKey: { $gte: range.from },
  }).sort({ periodStartKey: -1 });
  const rows = [];
  for (const record of records) {
    for (const line of record.lines) {
      rows.push({
        period: `${record.periodStartKey} to ${record.periodEndKey}`,
        kind: record.kind,
        founder: line.name,
        share: formatBasisPoints(line.bps),
        amountPaise: line.amountPaise,
        payout: record.payout ? 'Paid out' : 'Retained in capital',
      });
    }
  }
  return {
    title: 'Profit distribution',
    columns: [
      { key: 'period', header: 'Period', width: 28 },
      { key: 'kind', header: 'Kind' },
      { key: 'founder', header: 'Co-founder' },
      { key: 'share', header: 'Share %' },
      { key: 'amountPaise', header: 'Amount (INR)', money },
      { key: 'payout', header: 'Settlement' },
    ],
    rows,
  };
}

async function clients(range, query) {
  const filter = {};
  if (query.status) filter.status = query.status;
  const records = await Client.find(filter).sort({ name: 1 });
  return {
    title: 'Clients',
    columns: [
      { key: 'name', header: 'Client' },
      { key: 'company', header: 'Company' },
      { key: 'service', header: 'Service' },
      { key: 'status', header: 'Status' },
      { key: 'monthlyPaise', header: 'Monthly (INR)', money },
    ],
    rows: records.map((client) => ({
      name: client.name,
      company: client.companyName,
      service: [client.service, client.serviceType === 'other' ? client.serviceTypeOther : ''].filter(Boolean).join(' · ') || client.serviceType,
      status: client.status,
      monthlyPaise: client.monthlyAmountPaise,
    })),
  };
}

async function projects(range, query) {
  const filter = {};
  if (query.clientId) filter.clientId = query.clientId;
  if (query.status) filter.status = query.status;
  const records = await Project.find(filter).populate('clientId', 'name');
  const progress = await Task.aggregate([
    { $group: { _id: '$projectId', total: { $sum: 1 }, done: { $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] } } } },
  ]);
  const byProject = new Map(progress.map((row) => [String(row._id), row]));
  return {
    title: 'Projects',
    columns: [
      { key: 'name', header: 'Project' },
      { key: 'client', header: 'Client' },
      { key: 'status', header: 'Status' },
      { key: 'due', header: 'Due' },
      { key: 'progress', header: 'Complete %' },
    ],
    rows: records.map((project) => {
      const row = byProject.get(String(project._id));
      return {
        name: project.name,
        client: project.clientId?.name || '',
        status: project.status,
        due: project.dueDate || '',
        progress: row?.total ? Math.round((row.done / row.total) * 100) : 0,
      };
    }),
  };
}

async function taskReport(range, query) {
  const filter = { dueDate: { $gte: range.from, $lte: range.to } };
  if (query.status) filter.status = query.status;
  const records = await Task.find(filter).populate('projectId', 'name').populate('assigneeId', 'name');
  return {
    title: 'Tasks',
    columns: [
      { key: 'title', header: 'Task', width: 36 },
      { key: 'project', header: 'Project' },
      { key: 'assignee', header: 'Assignee' },
      { key: 'status', header: 'Status' },
      { key: 'due', header: 'Due' },
    ],
    rows: records.map((task) => ({
      title: task.title,
      project: task.projectId?.name || '',
      assignee: task.assigneeId?.name || '',
      status: task.status,
      due: task.dueDate || '',
    })),
  };
}

async function attendanceReport(range, query) {
  const filter = { dateKey: { $gte: range.from, $lte: range.to } };
  if (query.employeeId) filter.employeeId = query.employeeId;
  const records = await Attendance.find(filter);
  const employees = await Employee.find(query.employeeId ? { _id: query.employeeId } : {});
  const settings = await getSettings();
  const days = [];
  let cursor = range.from;
  while (cursor <= range.to && days.length < 400) {
    if (!(settings.weeklyOff || [0]).includes(weekdayIndex(cursor))) days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return {
    title: 'Attendance',
    columns: [
      { key: 'employee', header: 'Employee' },
      { key: 'present', header: 'Full days' },
      { key: 'half', header: 'Half days' },
      { key: 'leave', header: 'Leave' },
      { key: 'late', header: 'Late' },
      { key: 'absent', header: 'Absent' },
      { key: 'minutes', header: 'Minutes' },
    ],
    rows: employees.map((employee) => {
      const mine = records.filter((record) => String(record.employeeId) === String(employee._id));
      const present = mine.filter((record) => record.dayType === 'full' && record.checkInAt).length;
      const half = mine.filter((record) => record.dayType === 'half').length;
      const leave = mine.filter((record) => record.dayType === 'leave').length;
      return {
        employee: employee.fullName,
        present,
        half,
        leave,
        late: mine.filter((record) => record.late).length,
        absent: Math.max(0, days.length - present - half - leave),
        minutes: mine.reduce((sum, record) => sum + (record.workMinutes || 0), 0),
      };
    }),
  };
}

async function salaryReport(range, query) {
  const filter = { monthKey: { $gte: range.from.slice(0, 7), $lte: range.to.slice(0, 7) } };
  if (query.employeeId) filter.employeeId = query.employeeId;
  const records = await SalaryRecord.find(filter).populate('employeeId', 'fullName');
  return {
    title: 'Salary',
    columns: [
      { key: 'employee', header: 'Employee' },
      { key: 'month', header: 'Month' },
      { key: 'basePaise', header: 'Base (INR)', money },
      { key: 'bonusPaise', header: 'Bonus (INR)', money },
      { key: 'deductionPaise', header: 'Deduction (INR)', money },
      { key: 'netPaise', header: 'Net (INR)', money },
      { key: 'status', header: 'Status' },
    ],
    rows: records.map((row) => ({
      employee: row.employeeId?.fullName || '',
      month: row.monthKey,
      basePaise: row.basePaise,
      bonusPaise: row.bonusPaise,
      deductionPaise: row.deductionPaise,
      netPaise: row.status === 'paid' ? row.netPaise : row.basePaise + row.bonusPaise - row.deductionPaise,
      status: row.status,
    })),
  };
}

async function invoiceReport(range, query) {
  const filter = { dateKey: { $gte: range.from, $lte: range.to } };
  if (query.clientId) filter.clientId = query.clientId;
  if (query.status) filter.status = query.status;
  const records = await Invoice.find(filter).populate('clientId', 'name');
  return {
    title: 'Invoices',
    columns: [
      { key: 'number', header: 'Number' },
      { key: 'client', header: 'Client' },
      { key: 'date', header: 'Date' },
      { key: 'due', header: 'Due' },
      { key: 'totalPaise', header: 'Total (INR)', money },
      { key: 'paidPaise', header: 'Paid (INR)', money },
      { key: 'balancePaise', header: 'Balance (INR)', money },
      { key: 'status', header: 'Status' },
    ],
    rows: records.map((invoice) => ({
      number: invoice.number || 'Draft',
      client: invoice.clientId?.name || '',
      date: invoice.dateKey,
      due: invoice.dueDate,
      totalPaise: invoice.totalPaise,
      paidPaise: invoice.amountPaidPaise,
      balancePaise: invoice.totalPaise - invoice.amountPaidPaise,
      status: invoice.status,
    })),
  };
}

export async function integrityCheck() {
  const issues = [];
  const [posted] = await JournalLine.aggregate([
    { $lookup: { from: 'journalentries', localField: 'journalEntryId', foreignField: '_id', as: 'entry' } },
    { $unwind: '$entry' },
    { $match: { 'entry.status': 'posted' } },
    { $group: { _id: null, debit: { $sum: '$debitPaise' }, credit: { $sum: '$creditPaise' } } },
  ]);
  if ((posted?.debit || 0) !== (posted?.credit || 0)) issues.push('Posted debits and credits do not match.');
  const unbalanced = await JournalLine.aggregate([
    { $group: { _id: '$journalEntryId', debit: { $sum: '$debitPaise' }, credit: { $sum: '$creditPaise' } } },
    { $match: { $expr: { $ne: ['$debit', '$credit'] } } },
  ]);
  if (unbalanced.length) issues.push(`${unbalanced.length} journal ${unbalanced.length === 1 ? 'entry is' : 'entries are'} unbalanced.`);
  const banks = await BankAccount.find({ status: 'active' });
  for (const bank of banks) {
    const account = await LedgerAccount.findById(bank.ledgerAccountId);
    if (!account) {
      issues.push(`${bank.accountName} is not linked to a ledger account.`);
      continue;
    }
    const balance = await accountBalance(null, account);
    if (balance !== bank.currentBalancePaise) issues.push(`${bank.accountName} does not match its ledger.`);
  }
  const founders = await CoFounder.find();
  for (const founder of founders) {
    const parts = await founderParts(founder._id);
    if (!parts.reconciled) issues.push(`${founder.fullName}'s capital ledger does not match the recorded movements.`);
  }
  const entries = await JournalEntry.countDocuments({ status: 'posted', $expr: { $ne: ['$totalDebitPaise', '$totalCreditPaise'] } });
  if (entries) issues.push('A posted journal header is unbalanced.');
  return { ok: issues.length === 0, issues };
}

function labelType(type) {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export { formatInr, monthStart, monthEnd };
