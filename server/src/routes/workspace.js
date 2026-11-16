import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requirePerm, requireUser } from '../auth.js';
import { recordAudit } from '../audit.js';
import { PERMISSIONS } from '../constants.js';
import { assertTimeZone } from '../dates.js';
import { HttpError } from '../errors.js';
import { parse, searchRegex, wrap } from '../http.js';
import {
  CalendarEvent,
  Client,
  CoFounder,
  Employee,
  Invoice,
  JournalEntry,
  LedgerAccount,
  Notification,
  Project,
  StickyNote,
  StoredFile,
  Task,
  Transaction,
  User,
} from '../models.js';
import { CompanySettings } from '../models.js';
import { clearSettingsCache, getSettings } from '../settingsCache.js';
import { syncNotifications } from '../services/notify.js';
import { eventBody, noteBody } from './schemas.js';

const uploadDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../uploads');
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, callback) => {
      const extension = path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
      callback(null, `${crypto.randomUUID()}${extension}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const calendar = Router();
const notes = Router();
const notifications = Router();
const settings = Router();
const files = Router();
const search = Router();
for (const route of [calendar, notes, notifications, settings, files, search]) route.use(requireUser);

calendar.get('/', requirePerm('calendar.view'), wrap(async (req, res) => {
  const filter = {};
  if (req.query.from || req.query.to) {
    filter.dateKey = {};
    if (req.query.from) filter.dateKey.$gte = req.query.from;
    if (req.query.to) filter.dateKey.$lte = req.query.to;
  }
  if (req.query.eventType) filter.eventType = req.query.eventType;
  const data = await CalendarEvent.find(filter).sort({ dateKey: 1, startTime: 1 }).populate('clientId', 'name').populate('assigneeId', 'name').limit(500);
  res.json({ data });
}));

calendar.post('/', requirePerm('calendar.manage'), wrap(async (req, res) => {
  const body = parse(eventBody, req.body);
  const event = await CalendarEvent.create({ ...mapEvent(body), createdBy: req.user._id });
  res.status(201).json({ data: event });
}));

calendar.patch('/:id', requirePerm('calendar.manage'), wrap(async (req, res) => {
  const body = parse(eventBody.partial(), req.body);
  const event = await CalendarEvent.findByIdAndUpdate(req.params.id, mapEvent(body), { new: true });
  if (!event) throw new HttpError('Event not found', 404);
  res.json({ data: event });
}));

calendar.delete('/:id', requirePerm('calendar.manage'), wrap(async (req, res) => {
  const event = await CalendarEvent.findByIdAndDelete(req.params.id);
  if (!event) throw new HttpError('Event not found', 404);
  res.json({ data: { ok: true } });
}));

notes.get('/', requirePerm('notes.view'), wrap(async (req, res) => {
  const filter = { $or: [{ visibility: 'company' }, { ownerId: req.user._id }] };
  const regex = searchRegex(req.query.q);
  if (regex) filter.$and = [{ $or: [{ title: regex }, { body: regex }] }];
  const data = await StickyNote.find(filter).sort({ pinned: -1, updatedAt: -1 }).limit(200);
  res.json({ data });
}));

notes.post('/', requirePerm('notes.manage', 'notes.view'), wrap(async (req, res) => {
  const body = parse(noteBody, req.body);
  if (body.visibility === 'company' && !canManageNotes(req)) throw new HttpError('You can keep personal notes. Company notes need notes permission.', 403);
  const note = await StickyNote.create({ ...body, ownerId: req.user._id, visibility: body.visibility || 'private' });
  res.status(201).json({ data: note });
}));

notes.patch('/:id', requirePerm('notes.view'), wrap(async (req, res) => {
  const note = await StickyNote.findById(req.params.id);
  if (!note) throw new HttpError('Note not found', 404);
  if (!ownsNote(req, note)) throw new HttpError('You do not have permission to edit this note', 403);
  const body = parse(noteBody.partial(), req.body);
  Object.assign(note, body);
  await note.save();
  res.json({ data: note });
}));

notes.delete('/:id', requirePerm('notes.view'), wrap(async (req, res) => {
  const note = await StickyNote.findById(req.params.id);
  if (!note) throw new HttpError('Note not found', 404);
  if (!ownsNote(req, note)) throw new HttpError('You do not have permission to delete this note', 403);
  await note.deleteOne();
  res.json({ data: { ok: true } });
}));

notifications.get('/', requirePerm('notifications.view'), wrap(async (req, res) => {
  await syncNotifications();
  const prefs = req.user.notificationPrefs || {};
  const rows = await Notification.find({ resolved: false }).sort({ createdAt: -1 }).limit(100);
  const data = rows.filter((row) => prefs[row.preference] !== false).map((row) => ({
    ...row.toObject(),
    unread: !row.readBy.some((id) => String(id) === String(req.user._id)),
  }));
  res.json({ data, unread: data.filter((row) => row.unread).length });
}));

notifications.post('/:id/read', requirePerm('notifications.view'), wrap(async (req, res) => {
  await Notification.updateOne({ _id: req.params.id }, { $addToSet: { readBy: req.user._id } });
  res.json({ data: { ok: true } });
}));

notifications.post('/read-all', requirePerm('notifications.view'), wrap(async (req, res) => {
  await Notification.updateMany({ resolved: false }, { $addToSet: { readBy: req.user._id } });
  res.json({ data: { ok: true } });
}));

settings.get('/', requirePerm('settings.view', 'settings.manage'), wrap(async (_req, res) => {
  res.json({ data: await getSettings(), permissions: PERMISSIONS });
}));

settings.patch('/', requirePerm('settings.manage'), wrap(async (req, res) => {
  const body = parse(z.object({
    companyName: z.string().trim().min(1).max(120).optional(),
    legalName: z.string().max(160).optional(),
    address: z.string().max(500).optional(),
    phone: z.string().max(40).optional(),
    email: z.string().max(160).optional(),
    website: z.string().max(160).optional(),
    gstin: z.string().max(20).optional(),
    pan: z.string().max(20).optional(),
    logoKey: z.string().max(80).optional(),
    invoicePrefix: z.string().trim().min(1).max(8).optional(),
    financialYearStartMonth: z.coerce.number().int().min(1).max(12).optional(),
    currency: z.literal('INR').optional(),
    timezone: z.string().optional(),
    workStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    lateGraceMinutes: z.coerce.number().int().min(0).max(180).optional(),
    weeklyOff: z.array(z.number().int().min(0).max(6)).optional(),
    reminderDays: z.coerce.number().int().min(0).max(30).optional(),
    defaultTaxBps: z.coerce.number().int().min(0).max(4000).optional(),
    paymentInstructions: z.string().max(1000).optional(),
  }), req.body);
  if (body.timezone) assertTimeZone(body.timezone);
  if (body.currency) {
    const posted = await JournalEntry.countDocuments();
    const current = await getSettings();
    if (posted && current.currency && current.currency !== body.currency) {
      throw new HttpError('Currency stays INR once transactions exist');
    }
  }
  const settingsRow = await CompanySettings.findByIdAndUpdate('company', body, { new: true, upsert: true });
  clearSettingsCache();
  recordAudit(req, { action: 'settings', entityType: 'settings', summary: 'Updated company settings' });
  res.json({ data: settingsRow });
}));

files.post('/', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new HttpError('Choose a file to upload');
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain', 'text/csv'];
  if (!allowed.includes(req.file.mimetype)) {
    fs.unlink(req.file.path, () => undefined);
    throw new HttpError('Upload a PDF, CSV, text file, or image');
  }
  const record = await StoredFile.create({
    key: path.parse(req.file.filename).name,
    originalName: req.file.originalname,
    mime: req.file.mimetype,
    size: req.file.size,
    storedName: req.file.filename,
    uploadedBy: req.user._id,
    ownerType: req.body?.ownerType || '',
    ownerId: req.body?.ownerId || undefined,
  });
  res.status(201).json({ data: { key: record.key, name: record.originalName, mime: record.mime, size: record.size } });
}));

files.get('/:key', wrap(async (req, res) => {
  const file = await StoredFile.findOne({ key: req.params.key });
  if (!file) throw new HttpError('File not found', 404);
  if (file.ownerType === 'note') {
    const note = await StickyNote.findById(file.ownerId);
    if (note?.visibility === 'private' && String(note.ownerId) !== String(req.user._id) && req.user.role !== 'master_admin') {
      throw new HttpError('You do not have permission to open this file', 403);
    }
  } else if (!file.ownerType && String(file.uploadedBy) !== String(req.user._id) && req.user.role !== 'master_admin') {
    throw new HttpError('You do not have permission to open this file', 403);
  }
  const fullPath = path.resolve(uploadDir, path.basename(file.storedName));
  if (!fullPath.startsWith(uploadDir) || !fs.existsSync(fullPath)) throw new HttpError('File not found', 404);
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.download(fullPath, file.originalName || file.storedName);
}));

search.get('/', wrap(async (req, res) => {
  const regex = searchRegex(req.query.q);
  if (!regex) return res.json({ data: {} });
  const limit = 6;
  const [clients, projects, transactions, invoices, employees, founders, accounts, notes] = await Promise.all([
    Client.find({ $or: [{ name: regex }, { companyName: regex }, { email: regex }] }).limit(limit),
    Project.find({ name: regex }).limit(limit),
    Transaction.find({ $or: [{ reference: regex }, { description: regex }, { counterparty: regex }] }).limit(limit),
    Invoice.find({ number: regex }).limit(limit),
    Employee.find({ $or: [{ fullName: regex }, { email: regex }] }).limit(limit),
    CoFounder.find({ $or: [{ fullName: regex }, { email: regex }] }).limit(limit),
    LedgerAccount.find({ $or: [{ name: regex }, { code: regex }] }).limit(limit),
    StickyNote.find({ $and: [{ $or: [{ visibility: 'company' }, { ownerId: req.user._id }] }, { $or: [{ title: regex }, { body: regex }] }] }).limit(limit),
  ]);
  res.json({ data: { clients, projects, transactions, invoices, employees, founders, accounts, notes } });
}));

function mapEvent(body) {
  return {
    title: body.title,
    description: body.description,
    eventType: body.eventType,
    dateKey: body.date,
    startTime: body.startTime,
    endTime: body.endTime,
    location: body.location,
    assigneeId: body.assigneeId,
    clientId: body.clientId,
    projectId: body.projectId,
  };
}

function ownsNote(req, note) {
  return req.user.role === 'master_admin' || String(note.ownerId) === String(req.user._id) || (note.visibility === 'company' && canManageNotes(req));
}

function canManageNotes(req) {
  return req.user.role === 'master_admin' || req.user.permissions?.includes('notes.manage');
}

export { calendar, files, notes, notifications, search, settings };
