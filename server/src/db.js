import mongoose from 'mongoose';
import { config } from './config.js';
import {
  Attendance,
  AuditLog,
  BankAccount,
  CalendarEvent,
  Client,
  ClientPayment,
  CoFounder,
  CompanySettings,
  Counter,
  Employee,
  Expense,
  FounderContribution,
  FounderWithdrawal,
  Income,
  Invoice,
  InvoiceItem,
  JournalEntry,
  JournalLine,
  LedgerAccount,
  LoginCode,
  Notification,
  PersonalEntry,
  ProfitDistribution,
  Project,
  SalaryRecord,
  StickyNote,
  StoredFile,
  Task,
  Transaction,
  User,
} from './models.js';

const models = [
  User, CoFounder, FounderContribution, FounderWithdrawal, ProfitDistribution, Client, Project, Task,
  ClientPayment, BankAccount, Transaction, LedgerAccount, JournalEntry, JournalLine, Invoice, InvoiceItem,
  Income, Expense, Employee, Attendance, SalaryRecord, CalendarEvent, StickyNote, Notification, AuditLog,
  CompanySettings, Counter, PersonalEntry, StoredFile, LoginCode,
];

export async function connectDatabase() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri);
  await Promise.all(models.map((model) => model.createCollection().catch(() => undefined)));
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
