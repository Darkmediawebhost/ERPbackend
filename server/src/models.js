import mongoose from 'mongoose';

const { Schema, model } = mongoose;
const objectId = Schema.Types.ObjectId;

const fileRef = new Schema(
  {
    key: { type: String, required: true },
    name: String,
    mime: String,
    size: Number,
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    photoURL: String,
    firebaseUid: String,
    passwordHash: { type: String, select: false },
    role: { type: String, enum: ['master_admin', 'cofounder', 'employee', 'viewer'], default: 'viewer' },
    permissions: { type: [String], default: [] },
    coFounderId: { type: objectId, ref: 'CoFounder' },
    employeeId: { type: objectId, ref: 'Employee' },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    tokenVersion: { type: Number, default: 0 },
    theme: { type: String, enum: ['light', 'dark', 'system'], default: 'light' },
    notificationPrefs: {
      payments: { type: Boolean, default: true },
      projects: { type: Boolean, default: true },
      tasks: { type: Boolean, default: true },
      meetings: { type: Boolean, default: true },
      salary: { type: Boolean, default: true },
      invoices: { type: Boolean, default: true },
      calendar: { type: Boolean, default: true },
    },
    hasPassword: Boolean,
    lastLoginAt: Date,
  },
  { timestamps: true },
);
userSchema.index({ firebaseUid: 1 }, { sparse: true });

const coFounderSchema = new Schema(
  {
    seedKey: { type: String, unique: true, sparse: true },
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, default: '', trim: true },
    profileImage: String,
    designation: { type: String, default: 'Co-Founder', trim: true },
    joiningDate: Date,
    ownershipBps: { type: Number, default: 0, min: 0, max: 10000 },
    profitShareBps: { type: Number, default: 0, min: 0, max: 10000 },
    accessPermissions: { type: [String], default: [] },
    accountStatus: { type: String, enum: ['active', 'inactive'], default: 'active' },
    userId: { type: objectId, ref: 'User' },
    ledgerAccountId: { type: objectId, ref: 'LedgerAccount' },
  },
  { timestamps: true },
);

const founderContributionSchema = new Schema(
  {
    coFounderId: { type: objectId, ref: 'CoFounder', required: true, index: true },
    kind: { type: String, enum: ['initial', 'additional'], required: true },
    amountPaise: { type: Number, required: true, min: 1 },
    dateKey: { type: String, required: true, index: true },
    bankAccountId: { type: objectId, ref: 'BankAccount', required: true },
    paymentMethod: String,
    transactionReference: String,
    notes: String,
    journalEntryId: { type: objectId, ref: 'JournalEntry' },
    reference: String,
    idempotencyKey: String,
    recordedBy: { type: objectId, ref: 'User' },
    voided: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);
founderContributionSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

const founderWithdrawalSchema = new Schema(
  {
    coFounderId: { type: objectId, ref: 'CoFounder', required: true, index: true },
    kind: { type: String, enum: ['withdrawal', 'reimbursement'], required: true },
    amountPaise: { type: Number, required: true, min: 1 },
    dateKey: { type: String, required: true, index: true },
    bankAccountId: { type: objectId, ref: 'BankAccount', required: true },
    paymentMethod: String,
    transactionReference: String,
    notes: String,
    journalEntryId: { type: objectId, ref: 'JournalEntry' },
    reference: String,
    distributionId: { type: objectId, ref: 'ProfitDistribution' },
    idempotencyKey: String,
    recordedBy: { type: objectId, ref: 'User' },
    voided: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);
founderWithdrawalSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

const profitDistributionSchema = new Schema(
  {
    periodStartKey: { type: String, required: true },
    periodEndKey: { type: String, required: true },
    periodNetPaise: { type: Number, required: true },
    signedPaise: { type: Number, required: true },
    kind: { type: String, enum: ['profit', 'loss'], required: true },
    payout: { type: Boolean, default: false },
    bankAccountId: { type: objectId, ref: 'BankAccount' },
    lines: [
      {
        coFounderId: { type: objectId, ref: 'CoFounder' },
        name: String,
        bps: Number,
        amountPaise: Number,
      },
    ],
    journalEntryId: { type: objectId, ref: 'JournalEntry' },
    payoutJournalEntryId: { type: objectId, ref: 'JournalEntry' },
    reference: String,
    notes: String,
    idempotencyKey: String,
    approvedBy: { type: objectId, ref: 'User' },
    voided: { type: Boolean, default: false },
  },
  { timestamps: true },
);
profitDistributionSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
profitDistributionSchema.index({ periodStartKey: 1, periodEndKey: 1, voided: 1 });

const clientSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    companyName: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    email: { type: String, default: '', lowercase: true, trim: true },
    address: { type: String, default: '' },
    service: { type: String, default: '', trim: true },
    serviceType: { type: String, default: '' },
    serviceTypeOther: { type: String, default: '', trim: true },
    projectName: { type: String, default: '' },
    projectDescription: { type: String, default: '' },
    startDate: String,
    endDate: String,
    paymentType: { type: String, default: 'monthly_subscription' },
    monthlyAmountPaise: { type: Number, default: 0 },
    paymentDueDay: { type: Number, min: 1, max: 28, default: 1 },
    status: { type: String, enum: ['active', 'paused', 'completed', 'archived'], default: 'active' },
    internalNotes: { type: String, default: '' },
    ledgerAccountId: { type: objectId, ref: 'LedgerAccount' },
    documents: [fileRef],
    notes: [{ body: String, authorId: { type: objectId, ref: 'User' }, createdAt: { type: Date, default: Date.now } }],
  },
  { timestamps: true },
);
clientSchema.index({ name: 1 });
clientSchema.index({ status: 1 });

const projectSchema = new Schema(
  {
    clientId: { type: objectId, ref: 'Client', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    status: {
      type: String,
      enum: ['Planning', 'Not Started', 'In Progress', 'Review', 'Completed', 'On Hold'],
      default: 'Planning',
      index: true,
    },
    startDate: String,
    dueDate: String,
    memberIds: [{ type: objectId, ref: 'User' }],
    documents: [fileRef],
  },
  { timestamps: true },
);

const taskSchema = new Schema(
  {
    projectId: { type: objectId, ref: 'Project', required: true, index: true },
    clientId: { type: objectId, ref: 'Client', index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    status: { type: String, enum: ['To Do', 'In Progress', 'Review', 'Completed'], default: 'To Do', index: true },
    priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
    assigneeId: { type: objectId, ref: 'User' },
    startDate: String,
    dueDate: String,
    completedOn: { type: String, default: '' },
    comments: [{ body: String, authorId: { type: objectId, ref: 'User' }, createdAt: { type: Date, default: Date.now } }],
    documents: [fileRef],
  },
  { timestamps: true },
);

const receiptSchema = new Schema(
  {
    amountPaise: { type: Number, required: true, min: 1 },
    dateKey: { type: String, required: true },
    paymentMethod: String,
    transactionReference: String,
    bankAccountId: { type: objectId, ref: 'BankAccount' },
    journalEntryId: { type: objectId, ref: 'JournalEntry' },
    note: String,
    idempotencyKey: String,
    reversed: { type: Boolean, default: false },
    recordedBy: { type: objectId, ref: 'User' },
  },
  { timestamps: true },
);

const clientPaymentSchema = new Schema(
  {
    clientId: { type: objectId, ref: 'Client', required: true, index: true },
    projectId: { type: objectId, ref: 'Project' },
    invoiceId: { type: objectId, ref: 'Invoice' },
    paymentType: { type: String, required: true, trim: true },
    periodKey: { type: String, default: '' },
    invoiceAmountPaise: { type: Number, required: true, min: 1 },
    amountReceivedPaise: { type: Number, default: 0 },
    dueDate: { type: String, default: '', index: true },
    status: { type: String, enum: ['pending', 'partial', 'paid', 'overdue', 'void'], default: 'pending', index: true },
    notes: { type: String, default: '' },
    receipts: [receiptSchema],
    voided: { type: Boolean, default: false, index: true },
    recordedBy: { type: objectId, ref: 'User' },
  },
  { timestamps: true },
);
clientPaymentSchema.index(
  { clientId: 1, periodKey: 1, paymentType: 1 },
  {
    unique: true,
    partialFilterExpression: {
      paymentType: { $in: ['monthly_subscription', 'maintenance'] },
      voided: false,
    },
  },
);

const bankAccountSchema = new Schema(
  {
    accountName: { type: String, required: true, trim: true },
    bankName: { type: String, default: '' },
    accountHolder: { type: String, default: '' },
    accountNumber: { type: String, default: '' },
    accountType: { type: String, enum: ['cash', 'bank', 'online', 'business'], required: true },
    openingBalancePaise: { type: Number, default: 0 },
    currentBalancePaise: { type: Number, default: 0 },
    allowOverdraft: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    isSystem: { type: Boolean, default: false },
    ledgerAccountId: { type: objectId, ref: 'LedgerAccount' },
    reconciliations: [
      {
        asOf: String,
        statementBalancePaise: Number,
        bookBalancePaise: Number,
        differencePaise: Number,
        notes: String,
        by: { type: objectId, ref: 'User' },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);

const transactionSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true },
    dateKey: { type: String, required: true, index: true },
    amountPaise: { type: Number, required: true },
    direction: { type: String, enum: ['in', 'out'], required: true },
    bankAccountId: { type: objectId, ref: 'BankAccount', required: true, index: true },
    journalEntryId: { type: objectId, ref: 'JournalEntry', index: true },
    sourceType: String,
    sourceId: objectId,
    description: String,
    method: String,
    counterparty: String,
    bookStatus: { type: String, enum: ['posted', 'reversed', 'reversal'], default: 'posted', index: true },
  },
  { timestamps: true },
);

const ledgerAccountSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['asset', 'liability', 'equity', 'income', 'expense'], required: true, index: true },
    subtype: { type: String, default: '' },
    normalBalance: { type: String, enum: ['debit', 'credit'], required: true },
    ownerType: { type: String, enum: ['', 'founder', 'client', 'bank', 'system'], default: '' },
    ownerId: objectId,
    bankAccountId: { type: objectId, ref: 'BankAccount' },
    isSystem: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true },
);

const journalEntrySchema = new Schema(
  {
    entryNumber: { type: String, required: true, unique: true },
    reference: { type: String, required: true },
    dateKey: { type: String, required: true, index: true },
    memo: { type: String, default: '' },
    sourceType: { type: String, required: true, index: true },
    sourceId: objectId,
    sourceSubId: objectId,
    status: { type: String, enum: ['posted', 'reversed', 'reversal'], default: 'posted', index: true },
    reversalOf: { type: objectId, ref: 'JournalEntry' },
    reversedBy: { type: objectId, ref: 'JournalEntry' },
    reversalReason: String,
    idempotencyKey: String,
    postedBy: { type: objectId, ref: 'User' },
    totalDebitPaise: { type: Number, required: true },
    totalCreditPaise: { type: Number, required: true },
  },
  { timestamps: true },
);
journalEntrySchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

const journalLineSchema = new Schema(
  {
    journalEntryId: { type: objectId, ref: 'JournalEntry', required: true, index: true },
    ledgerAccountId: { type: objectId, ref: 'LedgerAccount', required: true, index: true },
    debitPaise: { type: Number, default: 0 },
    creditPaise: { type: Number, default: 0 },
    memo: String,
    partyType: { type: String, enum: ['', 'client', 'founder', 'employee'], default: '' },
    partyId: objectId,
  },
  { timestamps: true },
);

const invoiceSchema = new Schema(
  {
    number: { type: String, unique: true, sparse: true },
    clientId: { type: objectId, ref: 'Client', required: true, index: true },
    projectId: { type: objectId, ref: 'Project' },
    dateKey: String,
    dueDate: String,
    status: {
      type: String,
      enum: ['draft', 'sent', 'partial', 'paid', 'overdue', 'cancelled'],
      default: 'draft',
      index: true,
    },
    incomeCategory: { type: String, default: 'Client Payments' },
    subtotalPaise: { type: Number, default: 0 },
    discountPaise: { type: Number, default: 0 },
    taxBps: { type: Number, default: 0 },
    taxPaise: { type: Number, default: 0 },
    totalPaise: { type: Number, default: 0 },
    amountPaidPaise: { type: Number, default: 0 },
    notes: { type: String, default: '' },
    paymentInstructions: { type: String, default: '' },
    journalEntryId: { type: objectId, ref: 'JournalEntry' },
    receipts: [receiptSchema],
    idempotencyKey: String,
    createdBy: { type: objectId, ref: 'User' },
  },
  { timestamps: true },
);

const invoiceItemSchema = new Schema(
  {
    invoiceId: { type: objectId, ref: 'Invoice', required: true, index: true },
    description: { type: String, required: true },
    quantityMilli: { type: Number, required: true },
    ratePaise: { type: Number, required: true },
    amountPaise: { type: Number, required: true },
  },
  { timestamps: true },
);

const incomeSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    amountPaise: { type: Number, required: true, min: 1 },
    dateKey: { type: String, required: true, index: true },
    time: String,
    category: { type: String, required: true, index: true },
    clientId: { type: objectId, ref: 'Client' },
    projectId: { type: objectId, ref: 'Project' },
    bankAccountId: { type: objectId, ref: 'BankAccount', required: true },
    paymentMethod: String,
    transactionReference: String,
    description: { type: String, default: '' },
    attachment: fileRef,
    journalEntryId: { type: objectId, ref: 'JournalEntry' },
    reference: String,
    idempotencyKey: String,
    recordedBy: { type: objectId, ref: 'User' },
    voided: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);
incomeSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

const expenseSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    amountPaise: { type: Number, required: true, min: 1 },
    category: { type: String, required: true, index: true },
    dateKey: { type: String, required: true, index: true },
    time: String,
    paidByType: { type: String, enum: ['company', 'founder'], required: true },
    paidByFounderId: { type: objectId, ref: 'CoFounder' },
    bankAccountId: { type: objectId, ref: 'BankAccount' },
    paymentMethod: String,
    description: { type: String, default: '' },
    receipt: fileRef,
    isRecurring: { type: Boolean, default: false },
    recurrenceActive: { type: Boolean, default: false },
    recurrenceGroupId: String,
    nextRunDate: String,
    linkedSalaryId: { type: objectId, ref: 'SalaryRecord' },
    journalEntryId: { type: objectId, ref: 'JournalEntry' },
    reference: String,
    idempotencyKey: String,
    recordedBy: { type: objectId, ref: 'User' },
    voided: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);
expenseSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
expenseSchema.index({ recurrenceActive: 1, nextRunDate: 1 });

const employeeSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, default: '', trim: true },
    email: { type: String, lowercase: true, trim: true },
    address: { type: String, default: '' },
    designation: { type: String, default: '', trim: true },
    joiningDate: String,
    salaryPaise: { type: Number, default: 0, min: 0 },
    paymentDay: { type: Number, min: 1, max: 28, default: 1 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    profilePhoto: String,
    userId: { type: objectId, ref: 'User' },
    documents: [fileRef],
    performanceNotes: [{ body: String, authorId: { type: objectId, ref: 'User' }, createdAt: { type: Date, default: Date.now } }],
  },
  { timestamps: true },
);
employeeSchema.index({ email: 1 }, { unique: true, sparse: true });

const attendanceSchema = new Schema(
  {
    employeeId: { type: objectId, ref: 'Employee', required: true },
    dateKey: { type: String, required: true },
    checkInAt: Date,
    checkOutAt: Date,
    workMinutes: { type: Number, default: 0 },
    dayType: { type: String, enum: ['full', 'half', 'leave'], default: 'full' },
    leaveType: { type: String, default: '' },
    late: { type: Boolean, default: false },
    location: {
      consent: { type: Boolean, default: false },
      lat: Number,
      lng: Number,
      accuracy: Number,
    },
    notes: { type: String, default: '' },
    recordedBy: { type: objectId, ref: 'User' },
  },
  { timestamps: true },
);
attendanceSchema.index({ employeeId: 1, dateKey: 1 }, { unique: true });

const salaryRecordSchema = new Schema(
  {
    employeeId: { type: objectId, ref: 'Employee', required: true },
    monthKey: { type: String, required: true },
    basePaise: { type: Number, required: true, min: 0 },
    bonusPaise: { type: Number, default: 0, min: 0 },
    deductionPaise: { type: Number, default: 0, min: 0 },
    advanceRecoveryPaise: { type: Number, default: 0, min: 0 },
    netPaise: { type: Number, default: 0 },
    dueDate: String,
    status: { type: String, enum: ['draft', 'paid'], default: 'draft', index: true },
    paidDate: String,
    bankAccountId: { type: objectId, ref: 'BankAccount' },
    paymentMethod: String,
    journalEntryId: { type: objectId, ref: 'JournalEntry' },
    expenseId: { type: objectId, ref: 'Expense' },
    paymentIdempotencyKey: String,
    notes: { type: String, default: '' },
  },
  { timestamps: true },
);
salaryRecordSchema.index({ employeeId: 1, monthKey: 1 }, { unique: true });

const calendarEventSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    eventType: { type: String, required: true },
    dateKey: { type: String, required: true, index: true },
    startTime: { type: String, default: '' },
    endTime: { type: String, default: '' },
    location: { type: String, default: '' },
    assigneeId: { type: objectId, ref: 'User' },
    clientId: { type: objectId, ref: 'Client' },
    projectId: { type: objectId, ref: 'Project' },
    createdBy: { type: objectId, ref: 'User' },
  },
  { timestamps: true },
);

const stickyNoteSchema = new Schema(
  {
    title: { type: String, default: '', trim: true },
    body: { type: String, required: true },
    color: { type: String, default: '#FFF4CC' },
    pinned: { type: Boolean, default: false, index: true },
    reminderDate: String,
    reminderTime: { type: String, default: '' },
    visibility: { type: String, enum: ['private', 'company'], default: 'company', index: true },
    ownerId: { type: objectId, ref: 'User', required: true, index: true },
  },
  { timestamps: true },
);

const notificationSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    type: { type: String, required: true, index: true },
    preference: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    href: { type: String, default: '' },
    severity: { type: String, enum: ['info', 'warning', 'danger'], default: 'info' },
    dueDate: String,
    resolved: { type: Boolean, default: false, index: true },
    readBy: [{ type: objectId, ref: 'User' }],
  },
  { timestamps: true },
);

const auditLogSchema = new Schema(
  {
    actorId: { type: objectId, ref: 'User' },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: objectId,
    summary: { type: String, required: true },
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    ip: String,
  },
  { timestamps: true },
);
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

const companySettingsSchema = new Schema(
  {
    _id: { type: String, default: 'company' },
    companyName: { type: String, default: 'DARK MEDIA' },
    legalName: { type: String, default: 'Dark Media' },
    address: { type: String, default: '' },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    website: { type: String, default: '' },
    gstin: { type: String, default: '' },
    pan: { type: String, default: '' },
    logoKey: { type: String, default: '' },
    invoicePrefix: { type: String, default: 'DM' },
    financialYearStartMonth: { type: Number, default: 4, min: 1, max: 12 },
    currency: { type: String, default: 'INR' },
    timezone: { type: String, default: 'Asia/Kolkata' },
    workStart: { type: String, default: '10:00' },
    lateGraceMinutes: { type: Number, default: 0 },
    weeklyOff: { type: [Number], default: [0] },
    reminderDays: { type: Number, default: 3 },
    defaultTaxBps: { type: Number, default: 0 },
    paymentInstructions: { type: String, default: 'Pay by bank transfer and quote the invoice number.' },
    profitSharingActive: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const loginCodeSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    used: { type: Boolean, default: false },
  },
  { timestamps: true },
);
loginCodeSchema.index({ email: 1, used: 1, createdAt: -1 });
loginCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const counterSchema = new Schema({
  _id: String,
  seq: { type: Number, default: 0 },
});

const personalEntrySchema = new Schema(
  {
    person: { type: String, enum: ['sajeel', 'shakeeb', 'ismail'], required: true, index: true },
    kind: { type: String, enum: ['income', 'expense'], required: true, index: true },
    amountPaise: { type: Number, required: true, min: 1 },
    title: { type: String, required: true, trim: true },
    dateKey: { type: String, required: true, index: true },
    note: { type: String, default: '' },
    bankAccountId: { type: objectId, ref: 'BankAccount' },
    bankDirection: { type: String, enum: ['', 'in', 'out'], default: '' },
    movementType: { type: String, enum: ['', 'contribution', 'withdrawal'], default: '' },
    movementId: objectId,
    createdBy: { type: objectId, ref: 'User' },
  },
  { timestamps: true },
);

const storedFileSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    originalName: String,
    mime: String,
    size: Number,
    storedName: { type: String, required: true },
    ownerType: String,
    ownerId: objectId,
    uploadedBy: { type: objectId, ref: 'User' },
  },
  { timestamps: true },
);

export const User = model('User', userSchema);
export const CoFounder = model('CoFounder', coFounderSchema);
export const FounderContribution = model('FounderContribution', founderContributionSchema);
export const FounderWithdrawal = model('FounderWithdrawal', founderWithdrawalSchema);
export const ProfitDistribution = model('ProfitDistribution', profitDistributionSchema);
export const Client = model('Client', clientSchema);
export const Project = model('Project', projectSchema);
export const Task = model('Task', taskSchema);
export const ClientPayment = model('ClientPayment', clientPaymentSchema);
export const BankAccount = model('BankAccount', bankAccountSchema);
export const Transaction = model('Transaction', transactionSchema);
export const LedgerAccount = model('LedgerAccount', ledgerAccountSchema);
export const JournalEntry = model('JournalEntry', journalEntrySchema);
export const JournalLine = model('JournalLine', journalLineSchema);
export const Invoice = model('Invoice', invoiceSchema);
export const InvoiceItem = model('InvoiceItem', invoiceItemSchema);
export const Income = model('Income', incomeSchema);
export const Expense = model('Expense', expenseSchema);
export const Employee = model('Employee', employeeSchema);
export const Attendance = model('Attendance', attendanceSchema);
export const SalaryRecord = model('SalaryRecord', salaryRecordSchema);
export const CalendarEvent = model('CalendarEvent', calendarEventSchema);
export const StickyNote = model('StickyNote', stickyNoteSchema);
export const Notification = model('Notification', notificationSchema);
export const AuditLog = model('AuditLog', auditLogSchema);
const targetSchema = new Schema(
  {
    _id: { type: String, default: 'company' },
    dayPaise: { type: Number, default: 0, min: 0 },
    weekPaise: { type: Number, default: 0, min: 0 },
    monthPaise: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

const targetEntrySchema = new Schema(
  {
    dateKey: { type: String, required: true, index: true },
    amountPaise: { type: Number, required: true, min: 1 },
    note: { type: String, default: '', trim: true, maxlength: 160 },
    createdBy: { type: objectId, ref: 'User' },
  },
  { timestamps: true },
);

export const CompanySettings = model('CompanySettings', companySettingsSchema);
export const Target = model('Target', targetSchema);
export const TargetEntry = model('TargetEntry', targetEntrySchema);
export const LoginCode = model('LoginCode', loginCodeSchema);
export const Counter = model('Counter', counterSchema);
export const PersonalEntry = model('PersonalEntry', personalEntrySchema);
export const StoredFile = model('StoredFile', storedFileSchema);
