import { Router } from 'express';
import { z } from 'zod';
import { requirePerm, requireUser } from '../auth.js';
import { recordAudit } from '../audit.js';
import { EMPLOYEE_PERMISSIONS } from '../constants.js';
import { addDays, isLate, todayKey, weekdayIndex } from '../dates.js';
import { HttpError } from '../errors.js';
import { pageQuery, parse, searchRegex, sendList, wrap } from '../http.js';
import { Attendance, AuditLog, CoFounder, Employee, SalaryRecord, User } from '../models.js';
import { advanceBalance, paySalary, recordAdvance } from '../services/finance.js';
import { salarySlipPdf } from '../services/pdf.js';
import { getSettings } from '../settingsCache.js';
import { employeeBody, idempotencyKey, objectId, optionalId, positiveMoney, ymd } from './schemas.js';

const employees = Router();
const attendance = Router();
const salary = Router();
employees.use(requireUser);
attendance.use(requireUser);
salary.use(requireUser);

employees.get('/', requirePerm('employees.view'), wrap(async (req, res) => {
  const { page, limit, skip } = pageQuery(req.query);
  const filter = {};
  const regex = searchRegex(req.query.q);
  if (regex) filter.$or = [{ fullName: regex }, { email: regex }, { designation: regex }];
  if (req.query.status) filter.status = req.query.status;
  const [data, total] = await Promise.all([
    Employee.find(filter).sort({ fullName: 1 }).skip(skip).limit(limit),
    Employee.countDocuments(filter),
  ]);
  sendList(res, data, total, page, limit);
}));

employees.post('/', requirePerm('employees.manage'), wrap(async (req, res) => {
  const body = parse(employeeBody, req.body);
  const email = body.email ? body.email.toLowerCase() : undefined;
  if (email) await assertNotFounder(email);
  const employee = await Employee.create({
    fullName: body.fullName,
    phone: body.phone || '',
    ...(email ? { email } : {}),
    address: body.address || '',
    designation: body.designation,
    joiningDate: body.joiningDate,
    salaryPaise: body.salary || 0,
    paymentDay: body.paymentDay || 1,
    status: body.status || 'active',
    profilePhoto: body.profilePhoto,
  });
  if (email) {
    const user = await User.create({
      email,
      name: employee.fullName,
      role: 'employee',
      permissions: EMPLOYEE_PERMISSIONS,
      employeeId: employee._id,
      status: 'active',
    });
    employee.userId = user._id;
    await employee.save();
  }
  recordAudit(req, { action: 'create', entityType: 'employee', entityId: employee._id, summary: `Added employee ${employee.fullName}` });
  res.status(201).json({ data: employee });
}));

employees.get('/:id', requirePerm('employees.view'), wrap(async (req, res) => {
  const employee = await Employee.findById(req.params.id);
  if (!employee) throw new HttpError('Employee not found', 404);
  const [attendanceRows, salaryRows] = await Promise.all([
    Attendance.find({ employeeId: employee._id }).sort({ dateKey: -1 }).limit(60),
    SalaryRecord.find({ employeeId: employee._id }).sort({ monthKey: -1 }),
  ]);
  res.json({ data: employee, attendance: attendanceRows, salary: salaryRows, advanceBalancePaise: await advanceBalance(employee._id) });
}));

employees.patch('/:id', requirePerm('employees.manage'), wrap(async (req, res) => {
  const body = parse(employeeBody.partial(), req.body);
  const employee = await Employee.findById(req.params.id);
  if (!employee) throw new HttpError('Employee not found', 404);
  if (body.email) await assertNotFounder(body.email);
  if (body.fullName) employee.fullName = body.fullName;
  if (body.email) employee.email = body.email.toLowerCase();
  if (body.phone !== undefined) employee.phone = body.phone;
  if (body.address !== undefined) employee.address = body.address;
  if (body.designation !== undefined) employee.designation = body.designation;
  if (body.joiningDate) employee.joiningDate = body.joiningDate;
  if (body.salary !== undefined) employee.salaryPaise = body.salary;
  if (body.paymentDay) employee.paymentDay = body.paymentDay;
  if (body.status) employee.status = body.status;
  if (body.profilePhoto) employee.profilePhoto = body.profilePhoto;
  await employee.save();
  if (employee.userId) {
    await User.updateOne({ _id: employee.userId }, { name: employee.fullName, email: employee.email, status: employee.status === 'active' ? 'active' : 'disabled' });
  }
  res.json({ data: employee });
}));

employees.delete('/:id', requirePerm('employees.manage'), wrap(async (req, res) => {
  const employee = await Employee.findById(req.params.id);
  if (!employee) throw new HttpError('Employee not found', 404);
  const paid = await SalaryRecord.countDocuments({ employeeId: employee._id, status: 'paid' });
  if (paid) throw new HttpError('This employee has salary history. Mark them inactive instead of deleting them.');
  await Attendance.deleteMany({ employeeId: employee._id });
  await SalaryRecord.deleteMany({ employeeId: employee._id, status: 'draft' });
  if (employee.userId) await User.updateOne({ _id: employee.userId }, { status: 'disabled' });
  await employee.deleteOne();
  res.json({ data: { ok: true } });
}));

employees.post('/:id/notes', requirePerm('employees.manage'), wrap(async (req, res) => {
  const body = parse(z.object({ body: z.string().trim().min(1).max(4000) }), req.body);
  const employee = await Employee.findById(req.params.id);
  if (!employee) throw new HttpError('Employee not found', 404);
  employee.performanceNotes.push({ body: body.body, authorId: req.user._id });
  await employee.save();
  res.status(201).json({ data: employee.performanceNotes });
}));

attendance.get('/', requirePerm('attendance.view', 'attendance.manage'), wrap(async (req, res) => {
  const filter = {};
  if (req.query.employeeId) filter.employeeId = req.query.employeeId;
  if (req.query.month) filter.dateKey = { $regex: `^${String(req.query.month).slice(0, 7)}` };
  if (!req.user.permissions?.includes('attendance.manage') && req.user.role !== 'master_admin' && req.user.employeeId) {
    filter.employeeId = req.user.employeeId;
  }
  const data = await Attendance.find(filter).sort({ dateKey: -1 }).populate('employeeId', 'fullName').limit(400);
  res.json({ data });
}));

attendance.post('/check-in', requirePerm('attendance.view', 'attendance.manage'), wrap(async (req, res) => {
  const employee = await employeeForAction(req, req.body?.employeeId);
  const settings = await getSettings();
  const dateKey = todayKey(settings.timezone);
  const existing = await Attendance.findOne({ employeeId: employee._id, dateKey });
  if (existing?.checkInAt) throw new HttpError('Already checked in for today');
  const now = new Date();
  const location = readLocation(req.body?.location);
  const record = existing || new Attendance({ employeeId: employee._id, dateKey, recordedBy: req.user._id });
  record.checkInAt = now;
  record.late = isLate(now, settings.workStart, settings.lateGraceMinutes, settings.timezone);
  record.location = location;
  record.dayType = 'full';
  await record.save();
  res.status(201).json({ data: record });
}));

attendance.post('/check-out', requirePerm('attendance.view', 'attendance.manage'), wrap(async (req, res) => {
  const employee = await employeeForAction(req, req.body?.employeeId);
  const settings = await getSettings();
  const dateKey = todayKey(settings.timezone);
  const record = await Attendance.findOne({ employeeId: employee._id, dateKey });
  if (!record?.checkInAt) throw new HttpError('Check in before checking out');
  if (record.checkOutAt) throw new HttpError('Already checked out for today');
  const now = new Date();
  if (now < record.checkInAt) throw new HttpError('Check-out cannot be earlier than check-in');
  record.checkOutAt = now;
  record.workMinutes = Math.round((now - record.checkInAt) / 60000);
  await record.save();
  res.json({ data: record });
}));

attendance.post('/leave', requirePerm('attendance.manage'), wrap(async (req, res) => {
  const body = parse(z.object({
    employeeId: objectId,
    date: ymd,
    dayType: z.enum(['full', 'half', 'leave']),
    leaveType: z.string().max(80).optional(),
    notes: z.string().max(500).optional(),
  }), req.body);
  const before = await Attendance.findOne({ employeeId: body.employeeId, dateKey: body.date }).lean();
  const record = await Attendance.findOneAndUpdate(
    { employeeId: body.employeeId, dateKey: body.date },
    { dayType: body.dayType, leaveType: body.leaveType || '', notes: body.notes || '', recordedBy: req.user._id },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  await AuditLog.create({
    actorId: req.user._id,
    action: 'attendance-edit',
    entityType: 'attendance',
    entityId: record._id,
    summary: 'Updated attendance',
    before,
    after: { dayType: record.dayType, leaveType: record.leaveType, dateKey: record.dateKey },
    ip: req.ip,
  });
  res.json({ data: record });
}));

attendance.get('/report', requirePerm('attendance.view', 'attendance.manage'), wrap(async (req, res) => {
  const settings = await getSettings();
  const month = String(req.query.month || todayKey(settings.timezone).slice(0, 7));
  const start = `${month}-01`;
  const end = addDays(`${month}-28`, 10).startsWith(month) ? addDays(`${month}-28`, 10) : `${month}-28`;
  const last = [...Array(31)].reduce((latest) => latest, start);
  let cursor = start;
  let monthEnd = start;
  while (cursor.startsWith(month)) {
    monthEnd = cursor;
    cursor = addDays(cursor, 1);
  }
  const records = await Attendance.find({ dateKey: { $gte: start, $lte: monthEnd } });
  const people = await Employee.find({ status: 'active' });
  const working = [];
  cursor = start;
  while (cursor <= monthEnd) {
    if (!(settings.weeklyOff || [0]).includes(weekdayIndex(cursor))) working.push(cursor);
    cursor = addDays(cursor, 1);
  }
  res.json({
    data: people.map((employee) => {
      const mine = records.filter((record) => String(record.employeeId) === String(employee._id));
      const present = mine.filter((record) => record.dayType === 'full' && record.checkInAt).length;
      const half = mine.filter((record) => record.dayType === 'half').length;
      const leave = mine.filter((record) => record.dayType === 'leave').length;
      return {
        employee,
        present,
        half,
        leave,
        late: mine.filter((record) => record.late).length,
        absent: Math.max(0, working.length - present - half - leave),
        minutes: mine.reduce((sum, record) => sum + (record.workMinutes || 0), 0),
      };
    }),
  });
}));

salary.get('/', requirePerm('salary.view'), wrap(async (req, res) => {
  const filter = {};
  if (req.query.month) filter.monthKey = req.query.month;
  if (req.query.employeeId) filter.employeeId = req.query.employeeId;
  if (req.query.status) filter.status = req.query.status;
  const data = await SalaryRecord.find(filter).sort({ monthKey: -1 }).populate('employeeId', 'fullName designation');
  res.json({ data });
}));

salary.post('/generate', requirePerm('salary.manage'), wrap(async (req, res) => {
  const body = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }), req.body);
  const people = await Employee.find({ status: 'active' });
  const created = [];
  for (const employee of people) {
    const exists = await SalaryRecord.findOne({ employeeId: employee._id, monthKey: body.month });
    if (exists) continue;
    const dueDay = String(employee.paymentDay || 1).padStart(2, '0');
    created.push(await SalaryRecord.create({
      employeeId: employee._id,
      monthKey: body.month,
      basePaise: employee.salaryPaise || 0,
      dueDate: `${body.month}-${dueDay}`,
      status: 'draft',
    }));
  }
  res.status(201).json({ data: { created: created.length } });
}));

salary.patch('/:id', requirePerm('salary.manage'), wrap(async (req, res) => {
  const body = parse(z.object({
    bonus: z.union([z.string(), z.number()]).optional(),
    deduction: z.union([z.string(), z.number()]).optional(),
    notes: z.string().max(1000).optional(),
  }), req.body);
  const { rupeesToPaise } = await import('../money.js');
  const salaryRow = await SalaryRecord.findById(req.params.id);
  if (!salaryRow) throw new HttpError('Salary record not found', 404);
  if (salaryRow.status === 'paid') throw new HttpError('Paid salary cannot be edited. Void the payment first.');
  if (body.bonus !== undefined) salaryRow.bonusPaise = rupeesToPaise(body.bonus);
  if (body.deduction !== undefined) salaryRow.deductionPaise = rupeesToPaise(body.deduction);
  if (body.notes !== undefined) salaryRow.notes = body.notes;
  await salaryRow.save();
  res.json({ data: salaryRow });
}));

salary.post('/:id/advance', requirePerm('salary.manage'), wrap(async (req, res) => {
  const body = parse(z.object({
    amount: positiveMoney,
    date: ymd,
    bankAccountId: objectId,
    paymentMethod: z.string().optional(),
    idempotencyKey,
  }), req.body);
  const result = await recordAdvance(req.params.id, {
    amountPaise: body.amount,
    dateKey: body.date,
    bankAccountId: body.bankAccountId,
    paymentMethod: body.paymentMethod,
    idempotencyKey: body.idempotencyKey,
  }, req.user._id);
  res.status(201).json({ data: result });
}));

salary.post('/:id/pay', requirePerm('salary.manage'), wrap(async (req, res) => {
  const body = parse(z.object({
    date: ymd,
    bankAccountId: optionalId,
    paymentMethod: z.string().optional(),
    advanceRecovery: z.union([z.string(), z.number()]).optional(),
    idempotencyKey,
  }), req.body);
  const { rupeesToPaise } = await import('../money.js');
  const row = await paySalary(req.params.id, {
    dateKey: body.date,
    bankAccountId: body.bankAccountId,
    paymentMethod: body.paymentMethod,
    advanceRecoveryPaise: body.advanceRecovery ? rupeesToPaise(body.advanceRecovery) : 0,
    idempotencyKey: body.idempotencyKey,
  }, req.user._id);
  recordAudit(req, { action: 'pay', entityType: 'salary', entityId: row._id, summary: `Paid salary ${row.monthKey}` });
  res.json({ data: row });
}));

salary.get('/:id/slip', requirePerm('salary.view'), wrap(async (req, res) => {
  const row = await SalaryRecord.findById(req.params.id);
  if (!row) throw new HttpError('Salary record not found', 404);
  const employee = await Employee.findById(row.employeeId);
  const pdf = await salarySlipPdf({ salary: row, employee, settings: await getSettings() });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="salary-${row.monthKey}.pdf"`);
  res.send(pdf);
}));

async function assertNotFounder(email) {
  const founder = await CoFounder.findOne({ email: email.toLowerCase() });
  if (founder) throw new HttpError('Co-founders are not employees. Manage them in Co-Founder Management.');
  const user = await User.findOne({ email: email.toLowerCase(), coFounderId: { $ne: null } });
  if (user) throw new HttpError('This email belongs to a co-founder');
}

async function employeeForAction(req, requestedId) {
  const managing = req.user.role === 'master_admin' || req.user.permissions?.includes('attendance.manage');
  const employeeId = managing && requestedId ? requestedId : req.user.employeeId;
  if (!employeeId) throw new HttpError('Your user is not linked to an employee record', 403);
  const employee = await Employee.findById(employeeId);
  if (!employee || employee.status !== 'active') throw new HttpError('Employee is not active', 404);
  return employee;
}

function readLocation(location) {
  if (!location?.consent) return { consent: false };
  const lat = Number(location.lat);
  const lng = Number(location.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { consent: false };
  return { consent: true, lat, lng, accuracy: Number(location.accuracy) || undefined };
}

export { attendance, employees, salary };
