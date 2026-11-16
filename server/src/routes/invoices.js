import { Router } from 'express';
import { z } from 'zod';
import { requirePerm, requireUser } from '../auth.js';
import { recordAudit } from '../audit.js';
import { todayKey } from '../dates.js';
import { HttpError } from '../errors.js';
import { pageQuery, parse, sendList, wrap } from '../http.js';
import { Client, Invoice, InvoiceItem, JournalEntry, Project } from '../models.js';
import { formatInr } from '../money.js';
import { sendMail } from '../services/mail.js';
import { invoicePdf } from '../services/pdf.js';
import { issueInvoice, recordInvoiceReceipt, refreshOverdues, saveDraftInvoice, voidFinancial } from '../services/finance.js';
import { getSettings } from '../settingsCache.js';
import { invoiceBody, receiptBody } from './schemas.js';

const router = Router();
router.use(requireUser);

router.get('/', requirePerm('invoices.view'), wrap(async (req, res) => {
  await refreshOverdues();
  const { page, limit, skip } = pageQuery(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.clientId) filter.clientId = req.query.clientId;
  if (req.query.month) filter.dateKey = { $regex: `^${String(req.query.month).replace(/[^\d-]/g, '')}` };
  const [data, total] = await Promise.all([
    Invoice.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('clientId', 'name companyName email'),
    Invoice.countDocuments(filter),
  ]);
  sendList(res, data, total, page, limit);
}));

router.post('/', requirePerm('invoices.manage'), wrap(async (req, res) => {
  const body = parse(invoiceBody, req.body);
  const invoice = await saveDraftInvoice(invoiceInput(body), req.user._id);
  recordAudit(req, { action: 'create', entityType: 'invoice', entityId: invoice._id, summary: 'Created a draft invoice' });
  res.status(201).json({ data: invoice });
}));

router.get('/:id', requirePerm('invoices.view'), wrap(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id).populate('clientId');
  if (!invoice) throw new HttpError('Invoice not found', 404);
  const items = await InvoiceItem.find({ invoiceId: invoice._id });
  res.json({ data: invoice, items });
}));

router.patch('/:id/status', requirePerm('invoices.manage'), wrap(async (req, res) => {
  const body = parse(z.object({
    status: z.enum(['draft', 'sent', 'partial', 'paid', 'overdue', 'cancelled']),
  }), req.body);
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) throw new HttpError('Invoice not found', 404);
  if (body.status === 'sent' && invoice.status === 'draft') {
    const issued = await issueInvoice(invoice._id, req.user._id);
    recordAudit(req, { action: 'issue', entityType: 'invoice', entityId: issued._id, summary: `Issued invoice ${issued.number}` });
    res.json({ data: issued });
    return;
  }
  if (body.status === 'draft' && invoice.status !== 'draft') {
    const today = todayKey((await getSettings()).timezone);
    const receipts = (invoice.receipts || []).filter((receipt) => !receipt.reversed && receipt.journalEntryId);
    for (const receipt of receipts) {
      await voidFinancial(receipt.journalEntryId, req.user._id, 'Returned invoice to draft', today);
    }
    const current = await Invoice.findById(invoice._id);
    if (current?.journalEntryId) {
      const entry = await JournalEntry.findById(current.journalEntryId);
      if (entry?.status === 'posted') await voidFinancial(current.journalEntryId, req.user._id, 'Returned invoice to draft', today);
    }
    const fresh = await Invoice.findById(invoice._id);
    fresh.status = 'draft';
    fresh.amountPaidPaise = 0;
    await fresh.save();
    recordAudit(req, { action: 'update', entityType: 'invoice', entityId: fresh._id, summary: `Set invoice ${fresh.number || fresh._id} to draft` });
    res.json({ data: fresh });
    return;
  }
  invoice.status = body.status;
  if (body.status === 'paid') invoice.amountPaidPaise = invoice.totalPaise;
  if (body.status === 'sent' || body.status === 'overdue' || body.status === 'cancelled') {
    if (!invoice.receipts?.some((receipt) => !receipt.reversed)) invoice.amountPaidPaise = 0;
  }
  await invoice.save();
  recordAudit(req, { action: 'update', entityType: 'invoice', entityId: invoice._id, summary: `Set invoice ${invoice.number || invoice._id} to ${body.status}` });
  res.json({ data: invoice });
}));

router.patch('/:id', requirePerm('invoices.manage'), wrap(async (req, res) => {
  const body = parse(invoiceBody, req.body);
  const invoice = await saveDraftInvoice(invoiceInput(body), req.user._id, req.params.id);
  res.json({ data: invoice });
}));

router.delete('/:id', requirePerm('invoices.manage'), wrap(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) throw new HttpError('Invoice not found', 404);
  const today = todayKey((await getSettings()).timezone);
  const receipts = (invoice.receipts || []).filter((receipt) => !receipt.reversed && receipt.journalEntryId);
  for (const receipt of receipts) {
    await voidFinancial(receipt.journalEntryId, req.user._id, 'Deleted invoice', today);
  }
  const current = await Invoice.findById(invoice._id);
  if (current?.journalEntryId) {
    const entry = await JournalEntry.findById(current.journalEntryId);
    if (entry?.status === 'posted') await voidFinancial(current.journalEntryId, req.user._id, 'Deleted invoice', today);
  }
  await InvoiceItem.deleteMany({ invoiceId: invoice._id });
  await Invoice.deleteOne({ _id: invoice._id });
  recordAudit(req, { action: 'delete', entityType: 'invoice', entityId: invoice._id, summary: `Deleted invoice ${invoice.number || invoice._id}` });
  res.json({ data: { ok: true } });
}));

router.post('/:id/issue', requirePerm('invoices.manage'), wrap(async (req, res) => {
  const invoice = await issueInvoice(req.params.id, req.user._id);
  recordAudit(req, { action: 'issue', entityType: 'invoice', entityId: invoice._id, summary: `Issued invoice ${invoice.number}` });
  res.json({ data: invoice });
}));

router.post('/:id/receipts', requirePerm('invoices.manage', 'payments.manage'), wrap(async (req, res) => {
  const body = parse(receiptBody, req.body);
  const invoice = await recordInvoiceReceipt(req.params.id, {
    amountPaise: body.amount,
    dateKey: body.date,
    bankAccountId: body.bankAccountId,
    paymentMethod: body.paymentMethod,
    transactionReference: body.transactionReference,
    note: body.note,
    idempotencyKey: body.idempotencyKey,
    clientPaymentId: body.clientPaymentId,
  }, req.user._id);
  res.status(201).json({ data: invoice });
}));

router.post('/:id/void', requirePerm('invoices.manage', 'ledger.post'), wrap(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice?.journalEntryId) throw new HttpError('This invoice has not been issued', 400);
  const today = todayKey((await getSettings()).timezone);
  await voidFinancial(invoice.journalEntryId, req.user._id, req.body?.reason || 'Cancelled invoice', today);
  res.json({ data: { ok: true } });
}));

router.get('/:id/pdf', requirePerm('invoices.view'), wrap(async (req, res) => {
  const payload = await loadInvoice(req.params.id);
  const pdf = await invoicePdf(payload);
  const filename = `${payload.invoice.number || 'draft-invoice'}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`);
  res.send(pdf);
}));

router.post('/:id/email', requirePerm('invoices.manage'), wrap(async (req, res) => {
  const payload = await loadInvoice(req.params.id);
  if (!payload.invoice.number) throw new HttpError('Issue the invoice before sending it');
  if (!payload.client?.email) throw new HttpError('This client has no email address');
  const pdf = await invoicePdf(payload);
  const settings = payload.settings;
  await sendMail({
    to: payload.client.email,
    subject: `Invoice ${payload.invoice.number} from ${settings.companyName || 'DARK MEDIA'}`,
    text: `Please find invoice ${payload.invoice.number} attached. Balance due: ${formatInr(payload.invoice.totalPaise - payload.invoice.amountPaidPaise)}.`,
    attachments: [{ filename: `${payload.invoice.number}.pdf`, content: pdf }],
  });
  recordAudit(req, { action: 'email', entityType: 'invoice', entityId: payload.invoice._id, summary: `Emailed invoice ${payload.invoice.number}` });
  res.json({ data: { sent: true } });
}));

function invoiceInput(body) {
  return {
    clientId: body.clientId,
    projectId: body.projectId,
    dateKey: body.date,
    dueDate: body.dueDate,
    incomeCategory: body.incomeCategory || 'Client Payments',
    discountPaise: body.discount || 0,
    taxBps: body.taxPercent || 0,
    notes: body.notes || '',
    idempotencyKey: body.idempotencyKey,
    items: body.items.map((item) => ({ description: item.description, quantity: item.quantity, ratePaise: item.rate })),
  };
}

async function loadInvoice(id) {
  const invoice = await Invoice.findById(id);
  if (!invoice) throw new HttpError('Invoice not found', 404);
  const [items, client, settings, project] = await Promise.all([
    InvoiceItem.find({ invoiceId: invoice._id }),
    Client.findById(invoice.clientId),
    getSettings(),
    invoice.projectId ? Project.findById(invoice.projectId) : null,
  ]);
  return { invoice, items, client, settings, project };
}

export default router;
