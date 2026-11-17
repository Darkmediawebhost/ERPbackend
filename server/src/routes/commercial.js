import { Router } from 'express';
import { z } from 'zod';
import { requirePerm, requireUser } from '../auth.js';
import { todayKey } from '../dates.js';
import { recordAudit } from '../audit.js';
import { HttpError } from '../errors.js';
import { pageQuery, parse, searchRegex, sendList, sortFrom, wrap } from '../http.js';
import {
  AuditLog,
  CalendarEvent,
  Client,
  ClientPayment,
  CoFounder,
  Income,
  Invoice,
  InvoiceItem,
  Project,
  Task,
  User,
} from '../models.js';
import { createCharge, createClientRecord, recordClientReceipt, refreshOverdues, updateCharge, updateClientReceipt, voidCharge } from '../services/finance.js';
import { chargeBody, clientBody, projectBody, receiptBody, taskBody } from './schemas.js';

const clients = Router();
const projects = Router();
const tasks = Router();
const payments = Router();
clients.use(requireUser);
projects.use(requireUser);
tasks.use(requireUser);
payments.use(requireUser);

clients.get('/', requirePerm('clients.view'), wrap(async (req, res) => {
  const { page, limit, skip } = pageQuery(req.query);
  const filter = {};
  const regex = searchRegex(req.query.q);
  if (regex) filter.$or = [{ name: regex }, { companyName: regex }, { email: regex }, { phone: regex }, { service: regex }, { serviceTypeOther: regex }];
  if (req.query.status) filter.status = req.query.status;
  if (req.query.serviceType) filter.serviceType = req.query.serviceType;
  const [data, total] = await Promise.all([
    Client.find(filter).sort(sortFrom(req.query, ['name', 'createdAt', 'status'], 'name')).skip(skip).limit(limit),
    Client.countDocuments(filter),
  ]);
  sendList(res, data, total, page, limit);
}));

clients.post('/', requirePerm('clients.manage'), wrap(async (req, res) => {
  const body = parse(clientBody, req.body);
  assertClientService(body);
  const client = await createClientRecord(clientPayload(body));
  recordAudit(req, { action: 'create', entityType: 'client', entityId: client._id, summary: `Added client ${client.name}` });
  res.status(201).json({ data: client });
}));

clients.get('/:id', requirePerm('clients.view'), wrap(async (req, res) => {
  const client = await Client.findById(req.params.id);
  if (!client) throw new HttpError('Client not found', 404);
  const [projectRows, taskRows, paymentRows, invoices, income, timeline] = await Promise.all([
    Project.find({ clientId: client._id }).sort({ createdAt: -1 }),
    Task.find({ clientId: client._id }).sort({ dueDate: 1 }),
    ClientPayment.find({ clientId: client._id }).sort({ dueDate: -1 }),
    Invoice.find({ clientId: client._id }).sort({ createdAt: -1 }),
    Income.find({ clientId: client._id, voided: false }).sort({ dateKey: -1 }),
    AuditLog.find({ entityType: 'client', entityId: client._id }).sort({ createdAt: -1 }).limit(40),
  ]);
  res.json({ data: client, projects: projectRows, tasks: taskRows, payments: paymentRows, invoices, income, timeline });
}));

clients.patch('/:id', requirePerm('clients.manage'), wrap(async (req, res) => {
  const body = parse(clientBody.partial(), req.body);
  assertClientService(body);
  const client = await Client.findById(req.params.id);
  if (!client) throw new HttpError('Client not found', 404);
  Object.assign(client, clientPayload(body, true));
  if (body.name) client.name = body.name;
  await client.save();
  recordAudit(req, { action: 'update', entityType: 'client', entityId: client._id, summary: `Updated client ${client.name}` });
  res.json({ data: client });
}));

clients.delete('/:id', requirePerm('clients.manage'), wrap(async (req, res) => {
  const client = await Client.findById(req.params.id);
  if (!client) throw new HttpError('Client not found', 404);
  const [invoices, receipts, income] = await Promise.all([
    Invoice.countDocuments({ clientId: client._id, status: { $ne: 'draft' } }),
    ClientPayment.countDocuments({ clientId: client._id, amountReceivedPaise: { $gt: 0 } }),
    Income.countDocuments({ clientId: client._id, voided: false }),
  ]);
  if (invoices || receipts || income) {
    throw new HttpError('This client has invoices or received payments, so it cannot be deleted.');
  }
  const drafts = await Invoice.find({ clientId: client._id, status: 'draft' }).select('_id');
  await Promise.all([
    InvoiceItem.deleteMany({ invoiceId: { $in: drafts.map((invoice) => invoice._id) } }),
    Invoice.deleteMany({ clientId: client._id, status: 'draft' }),
    ClientPayment.deleteMany({ clientId: client._id }),
    Task.deleteMany({ clientId: client._id }),
    Project.deleteMany({ clientId: client._id }),
    CalendarEvent.deleteMany({ clientId: client._id }),
  ]);
  await client.deleteOne();
  recordAudit(req, { action: 'delete', entityType: 'client', entityId: client._id, summary: `Deleted client ${client.name}` });
  res.json({ data: { ok: true } });
}));

clients.post('/:id/notes', requirePerm('clients.manage'), wrap(async (req, res) => {
  const body = parse(z.object({ body: z.string().trim().min(1).max(4000) }), req.body);
  const client = await Client.findById(req.params.id);
  if (!client) throw new HttpError('Client not found', 404);
  client.notes.push({ body: body.body, authorId: req.user._id });
  await client.save();
  res.status(201).json({ data: client.notes });
}));

projects.get('/', requirePerm('projects.view'), wrap(async (req, res) => {
  const filter = {};
  if (req.query.clientId) filter.clientId = req.query.clientId;
  if (req.query.status) filter.status = req.query.status;
  const regex = searchRegex(req.query.q);
  if (regex) filter.name = regex;
  const rows = await Project.find(filter).sort({ updatedAt: -1 }).populate('clientId', 'name companyName').limit(200);
  const progress = await Task.aggregate([
    { $group: { _id: '$projectId', total: { $sum: 1 }, done: { $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] } } } },
  ]);
  const byId = new Map(progress.map((row) => [String(row._id), row]));
  res.json({
    data: rows.map((project) => {
      const row = byId.get(String(project._id));
      return { ...project.toObject(), progress: row?.total ? Math.round((row.done / row.total) * 100) : 0, taskCount: row?.total || 0 };
    }),
  });
}));

projects.post('/', requirePerm('projects.manage'), wrap(async (req, res) => {
  const body = parse(projectBody, req.body);
  const project = await Project.create({ ...body, clientId: body.clientId });
  await Task.updateMany({ projectId: project._id }, { clientId: project.clientId });
  recordAudit(req, { action: 'create', entityType: 'project', entityId: project._id, summary: `Created project ${project.name}` });
  res.status(201).json({ data: project });
}));

projects.patch('/:id', requirePerm('projects.manage'), wrap(async (req, res) => {
  const body = parse(projectBody.partial(), req.body);
  const project = await Project.findByIdAndUpdate(req.params.id, body, { new: true });
  if (!project) throw new HttpError('Project not found', 404);
  res.json({ data: project });
}));

projects.delete('/:id', requirePerm('projects.manage'), wrap(async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) throw new HttpError('Project not found', 404);
  const tasksOpen = await Task.countDocuments({ projectId: project._id, status: { $ne: 'Completed' } });
  if (tasksOpen) throw new HttpError('Complete or remove the open tasks before deleting this project');
  await Task.deleteMany({ projectId: project._id, status: 'Completed' });
  await project.deleteOne();
  res.json({ data: { ok: true } });
}));

tasks.get('/', requirePerm('projects.view'), wrap(async (req, res) => {
  const filter = {};
  if (req.query.projectId) filter.projectId = req.query.projectId;
  if (req.query.clientId) filter.clientId = req.query.clientId;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.assigneeId) filter.assigneeId = req.query.assigneeId;
  const regex = searchRegex(req.query.q);
  if (regex) filter.title = regex;
  const data = await Task.find(filter).sort({ dueDate: 1, createdAt: -1 }).populate('assigneeId', 'name').populate('projectId', 'name').limit(300);
  res.json({ data });
}));

tasks.post('/', requirePerm('projects.manage'), wrap(async (req, res) => {
  const body = parse(taskBody, req.body);
  const project = await Project.findById(body.projectId);
  if (!project) throw new HttpError('Project not found', 404);
  const task = await Task.create({
    ...body,
    clientId: project.clientId,
    completedOn: body.status === 'Completed' ? todayKey() : '',
  });
  res.status(201).json({ data: task });
}));

tasks.patch('/:id', requirePerm('projects.manage'), wrap(async (req, res) => {
  const body = parse(taskBody.partial().omit({ projectId: true }), req.body);
  const task = await Task.findById(req.params.id);
  if (!task) throw new HttpError('Task not found', 404);
  const previous = task.status;
  Object.assign(task, body);
  if (task.status === 'Completed' && previous !== 'Completed') task.completedOn = todayKey();
  if (task.status !== 'Completed') task.completedOn = '';
  await task.save();
  res.json({ data: task });
}));

tasks.delete('/:id', requirePerm('projects.manage'), wrap(async (req, res) => {
  const task = await Task.findByIdAndDelete(req.params.id);
  if (!task) throw new HttpError('Task not found', 404);
  res.json({ data: { ok: true } });
}));

tasks.post('/:id/comments', requirePerm('projects.view'), wrap(async (req, res) => {
  const body = parse(z.object({ body: z.string().trim().min(1).max(4000) }), req.body);
  const task = await Task.findById(req.params.id);
  if (!task) throw new HttpError('Task not found', 404);
  task.comments.push({ body: body.body, authorId: req.user._id });
  await task.save();
  res.status(201).json({ data: task.comments });
}));

payments.get('/', requirePerm('payments.view'), wrap(async (req, res) => {
  await refreshOverdues();
  const { page, limit, skip } = pageQuery(req.query);
  const filter = { voided: req.query.includeVoid === 'true' ? { $in: [true, false] } : false };
  if (req.query.clientId) filter.clientId = req.query.clientId;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.paymentType) filter.paymentType = req.query.paymentType;
  if (req.query.month) filter.periodKey = req.query.month;
  const [rows, total, summary] = await Promise.all([
    ClientPayment.find(filter).sort({ dueDate: 1 }).skip(skip).limit(limit).populate('clientId', 'name companyName').populate('receipts.bankAccountId', 'accountName accountType'),
    ClientPayment.countDocuments(filter),
    ClientPayment.aggregate([
      { $match: filter },
      { $group: { _id: null, invoiced: { $sum: '$invoiceAmountPaise' }, received: { $sum: '$amountReceivedPaise' } } },
    ]),
  ]);
  const invoiced = summary[0]?.invoiced || 0;
  const received = summary[0]?.received || 0;
  sendList(res, rows, total, page, limit, { invoicedPaise: invoiced, receivedPaise: received, outstandingPaise: invoiced - received });
}));

payments.post('/', requirePerm('payments.manage'), wrap(async (req, res) => {
  const body = parse(chargeBody, req.body);
  const doc = await createCharge({
    clientId: body.clientId,
    projectId: body.projectId,
    invoiceId: body.invoiceId,
    paymentType: body.paymentType,
    periodKey: body.periodKey || `manual-${Date.now()}`,
    invoiceAmountPaise: body.amount,
    dueDate: body.dueDate || '',
    notes: body.notes || '',
  }, req.user._id);
  recordAudit(req, { action: 'create', entityType: 'clientPayment', entityId: doc._id, summary: 'Created a client payment schedule' });
  res.status(201).json({ data: doc });
}));

payments.post('/generate', requirePerm('payments.manage'), wrap(async (req, res) => {
  const body = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }), req.body);
  const clients = await Client.find({ status: 'active', paymentType: { $in: ['monthly_subscription', 'maintenance'] }, monthlyAmountPaise: { $gt: 0 } });
  const created = [];
  const skipped = [];
  for (const client of clients) {
    try {
      const dueDay = String(client.paymentDueDay || 1).padStart(2, '0');
      const doc = await createCharge({
        clientId: client._id,
        paymentType: client.paymentType,
        periodKey: body.month,
        invoiceAmountPaise: client.monthlyAmountPaise,
        dueDate: `${body.month}-${dueDay}`,
        notes: 'Generated from the client monthly amount',
      }, req.user._id);
      created.push(doc);
    } catch (error) {
      if (error.status === 409) skipped.push(client.name);
      else throw error;
    }
  }
  res.json({ data: { created: created.length, skipped } });
}));

payments.patch('/:id', requirePerm('payments.manage'), wrap(async (req, res) => {
  const body = parse(chargeBody.pick({ paymentType: true, amount: true }), req.body);
  const doc = await updateCharge(req.params.id, {
    paymentType: body.paymentType,
    invoiceAmountPaise: body.amount,
  });
  recordAudit(req, { action: 'update', entityType: 'clientPayment', entityId: doc._id, summary: 'Edited a client payment' });
  res.json({ data: doc });
}));

payments.patch('/:id/receipts/:receiptId', requirePerm('payments.manage'), wrap(async (req, res) => {
  const body = parse(receiptBody.omit({ clientPaymentId: true, idempotencyKey: true }), req.body);
  const doc = await updateClientReceipt(req.params.id, req.params.receiptId, {
    amountPaise: body.amount,
    dateKey: body.date,
    bankAccountId: body.bankAccountId,
    paymentMethod: body.paymentMethod,
    transactionReference: body.transactionReference,
    note: body.note,
  }, req.user._id);
  recordAudit(req, { action: 'update', entityType: 'clientPayment', entityId: doc._id, summary: 'Edited a client receipt' });
  res.json({ data: doc });
}));

payments.post('/:id/receipts', requirePerm('payments.manage'), wrap(async (req, res) => {
  const body = parse(receiptBody.omit({ clientPaymentId: true }), req.body);
  const doc = await recordClientReceipt(req.params.id, {
    amountPaise: body.amount,
    dateKey: body.date,
    bankAccountId: body.bankAccountId,
    paymentMethod: body.paymentMethod,
    transactionReference: body.transactionReference,
    note: body.note,
    idempotencyKey: body.idempotencyKey,
  }, req.user._id);
  recordAudit(req, { action: 'receipt', entityType: 'clientPayment', entityId: doc._id, summary: 'Recorded a client receipt' });
  res.status(201).json({ data: doc });
}));

payments.post('/:id/void', requirePerm('payments.manage'), wrap(async (req, res) => {
  const doc = await voidCharge(req.params.id);
  res.json({ data: doc });
}));

function assertClientService(body) {
  if (body.serviceType === 'other' && !String(body.serviceTypeOther || '').trim()) {
    throw new HttpError('Type the other service type');
  }
}

function clientPayload(body, partial = false) {
  const payload = {};
  const assign = (key, value) => {
    if (value !== undefined) payload[key] = value;
  };
  assign('name', body.name);
  assign('companyName', body.companyName);
  assign('phone', body.phone);
  assign('email', body.email);
  assign('address', body.address);
  assign('service', body.service);
  assign('serviceType', body.serviceType);
  if (body.serviceType === 'other') assign('serviceTypeOther', body.serviceTypeOther);
  else if (body.serviceType) payload.serviceTypeOther = '';
  if (body.serviceType === 'monthly_subscription') payload.paymentType = 'monthly_subscription';
  else if (body.serviceType === 'project_based') payload.paymentType = 'project_based';
  else if (body.serviceType === 'other') payload.paymentType = 'one_time';
  assign('projectName', body.projectName);
  assign('projectDescription', body.projectDescription);
  assign('startDate', body.startDate || (partial ? undefined : todayKey()));
  assign('endDate', body.endDate || undefined);
  if (!body.serviceType) assign('paymentType', body.paymentType);
  if (body.monthlyAmount !== undefined) payload.monthlyAmountPaise = body.monthlyAmount;
  assign('paymentDueDay', body.paymentDueDay);
  assign('status', body.status);
  assign('internalNotes', body.internalNotes);
  if (!partial) {
    payload.companyName ||= '';
    payload.email ||= '';
  }
  return payload;
}

export { clients, payments, projects, tasks, User, CoFounder };
