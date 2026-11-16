import { z } from 'zod';
import { basisPointsFromPercent, rupeesToPaise } from '../money.js';
import {
  EVENT_TYPES,
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  PAYMENT_METHODS,
  PAYMENT_TYPES,
  PROJECT_STATUSES,
  TASK_STATUSES,
} from '../constants.js';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
export const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const monthKey = z.string().regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM');
export const idempotencyKey = z.string().trim().min(8).max(100);

const moneyString = z.union([z.string(), z.number()]).transform((value, context) => {
  try {
    return rupeesToPaise(value);
  } catch (error) {
    context.addIssue({ code: 'custom', message: error.message });
    return z.NEVER;
  }
});

export const money = moneyString;
export const positiveMoney = moneyString.refine((value) => value > 0, 'Amount must be greater than zero');
export const nonNegativeMoney = moneyString.refine((value) => value >= 0, 'Amount cannot be negative');

export const percent = z.union([z.string(), z.number()]).transform((value, context) => {
  try {
    return basisPointsFromPercent(value);
  } catch (error) {
    context.addIssue({ code: 'custom', message: error.message });
    return z.NEVER;
  }
});

export const optionalId = z.union([objectId, z.literal('')]).optional().transform((value) => value || undefined);

const category = (values) => z.string().refine((value) => values.includes(value), 'Unknown category');

export const incomeBody = z.object({
  title: z.string().trim().min(1).max(160),
  amount: positiveMoney,
  date: ymd,
  time: z.string().max(8).optional(),
  category: category(INCOME_CATEGORIES),
  clientId: optionalId,
  projectId: optionalId,
  bankAccountId: optionalId,
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  transactionReference: z.string().max(80).optional(),
  description: z.string().max(2000).optional(),
  attachmentKey: z.string().max(80).optional(),
  idempotencyKey,
});

export const expenseBody = z.object({
  title: z.string().trim().min(1).max(160),
  amount: positiveMoney,
  category: category(EXPENSE_CATEGORIES),
  date: ymd,
  time: z.string().max(8).optional(),
  paidByType: z.enum(['company', 'founder']),
  paidByFounderId: optionalId,
  bankAccountId: optionalId,
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  description: z.string().max(2000).optional(),
  receiptKey: z.string().max(80).optional(),
  isRecurring: z.boolean().optional(),
  idempotencyKey,
});

export const founderBody = z.object({
  fullName: z.string().trim().min(1).max(120),
  email: z.string().email(),
  phone: z.string().max(30).optional(),
  designation: z.string().max(80).optional(),
  joiningDate: ymd.optional(),
  ownership: percent.optional(),
  profitShare: percent.optional(),
  profileImage: z.string().max(80).optional(),
  accountStatus: z.enum(['active', 'inactive']).optional(),
});

export const clientBody = z.object({
  name: z.string().trim().min(1).max(160),
  companyName: z.string().max(160).optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().max(500).optional(),
  service: z.string().trim().max(160).optional(),
  serviceType: z.enum(['monthly_subscription', 'project_based', 'other']).optional(),
  serviceTypeOther: z.string().trim().max(120).optional(),
  projectName: z.string().max(160).optional(),
  projectDescription: z.string().max(4000).optional(),
  startDate: ymd.optional().or(z.literal('')),
  endDate: ymd.optional().or(z.literal('')),
  paymentType: z.enum(PAYMENT_TYPES).optional(),
  monthlyAmount: nonNegativeMoney.optional(),
  paymentDueDay: z.coerce.number().int().min(1).max(28).optional(),
  status: z.enum(['active', 'paused', 'completed', 'archived']).optional(),
  internalNotes: z.string().max(4000).optional(),
});

export const projectBody = z.object({
  clientId: objectId,
  name: z.string().trim().min(1).max(160),
  description: z.string().max(8000).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  startDate: z.string().max(10).optional(),
  dueDate: z.string().max(10).optional(),
  memberIds: z.array(objectId).optional(),
});

export const taskBody = z.object({
  projectId: objectId,
  title: z.string().trim().min(1).max(180),
  description: z.string().max(8000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  assigneeId: optionalId,
  startDate: z.string().max(10).optional(),
  dueDate: z.string().max(10).optional(),
});

export const chargeBody = z.object({
  clientId: objectId,
  projectId: optionalId,
  invoiceId: optionalId,
  paymentType: z.string().trim().min(1).max(80),
  periodKey: monthKey.optional(),
  amount: positiveMoney,
  dueDate: z.union([ymd, z.literal('')]).optional(),
  notes: z.string().max(2000).optional(),
});

export const receiptBody = z.object({
  amount: positiveMoney,
  date: ymd,
  bankAccountId: optionalId,
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  transactionReference: z.string().max(80).optional(),
  note: z.string().max(1000).optional(),
  idempotencyKey,
  clientPaymentId: optionalId,
});

export const bankBody = z.object({
  accountName: z.string().trim().min(1).max(120),
  bankName: z.string().max(120).optional(),
  accountHolder: z.string().max(120).optional(),
  accountNumber: z.string().max(40).optional(),
  accountType: z.enum(['cash', 'bank', 'online', 'business']),
  openingBalance: nonNegativeMoney.optional(),
  openingDate: z.union([ymd, z.literal('')]).optional(),
  allowOverdraft: z.boolean().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

export const movementBody = z.object({
  coFounderId: objectId,
  kind: z.string().optional(),
  amount: positiveMoney,
  date: ymd,
  bankAccountId: objectId,
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  transactionReference: z.string().max(80).optional(),
  notes: z.string().max(2000).optional(),
  allowCapitalOverdraw: z.boolean().optional(),
  idempotencyKey,
});

export const distributionBody = z.object({
  periodStart: ymd,
  periodEnd: ymd,
  date: ymd,
  amount: money.optional(),
  payout: z.boolean().optional(),
  bankAccountId: optionalId,
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  notes: z.string().max(2000).optional(),
  confirm: z.literal(true),
  idempotencyKey,
});

export const invoiceBody = z.object({
  clientId: objectId,
  projectId: optionalId,
  date: ymd,
  dueDate: ymd,
  incomeCategory: category(INCOME_CATEGORIES).optional(),
  discount: nonNegativeMoney.optional(),
  taxPercent: percent.optional(),
  notes: z.string().max(4000).optional(),
  idempotencyKey: idempotencyKey.optional(),
  items: z.array(z.object({
    description: z.string().trim().min(1).max(400),
    quantity: z.union([z.string(), z.number()]),
    rate: nonNegativeMoney,
  })).min(1),
});

export const employeeBody = z.object({
  fullName: z.string().trim().min(1).max(120),
  phone: z.string().max(30).optional(),
  email: z.union([z.string().email(), z.literal('')]).optional(),
  address: z.string().max(500).optional(),
  designation: z.string().trim().min(1).max(80),
  joiningDate: ymd.optional(),
  salary: nonNegativeMoney.optional(),
  paymentDay: z.coerce.number().int().min(1).max(28).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  profilePhoto: z.string().max(80).optional(),
});

export const eventBody = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(4000).optional(),
  eventType: z.enum(EVENT_TYPES),
  date: ymd,
  startTime: z.string().max(8).optional(),
  endTime: z.string().max(8).optional(),
  location: z.string().max(200).optional(),
  assigneeId: optionalId,
  clientId: optionalId,
  projectId: optionalId,
});

export const noteBody = z.object({
  title: z.string().max(120).optional(),
  body: z.string().trim().min(1).max(4000),
  color: z.string().trim().max(20).optional().refine((value) => !value || /^(white|gray|ink|tint|#[0-9a-fA-F]{6})$/.test(value), 'Use a light color'),
  pinned: z.boolean().optional(),
  reminderDate: z.union([ymd, z.literal('')]).optional(),
  reminderTime: z.string().regex(/^$|^\d{2}:\d{2}$/, 'Use a time').optional(),
  visibility: z.enum(['private', 'company']).optional(),
});

export const manualJournalBody = z.object({
  date: ymd,
  memo: z.string().trim().min(1).max(400),
  idempotencyKey,
  lines: z.array(z.object({
    accountId: objectId,
    debit: money.optional(),
    credit: money.optional(),
    memo: z.string().max(200).optional(),
  })).min(2),
});
