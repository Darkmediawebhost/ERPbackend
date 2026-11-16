import { addDays, todayKey } from '../dates.js';
import {
  CalendarEvent,
  ClientPayment,
  Invoice,
  Notification,
  Project,
  SalaryRecord,
  Task,
} from '../models.js';
import { getSettings } from '../settingsCache.js';

export async function syncNotifications() {
  const settings = await getSettings();
  const today = todayKey(settings.timezone);
  const soon = addDays(today, settings.reminderDays ?? 3);
  const activeKeys = [];

  const payments = await ClientPayment.find({
    voided: false,
    status: { $in: ['pending', 'partial', 'overdue'] },
    dueDate: { $lte: soon },
  }).populate('clientId', 'name').limit(200);

  for (const payment of payments) {
    const overdue = payment.dueDate < today;
    const key = `${overdue ? 'payment-overdue' : 'payment-due'}:${payment._id}`;
    activeKeys.push(key);
    await upsert(key, {
      type: overdue ? 'payment_overdue' : 'payment_due',
      preference: 'payments',
      title: overdue ? 'Client payment overdue' : 'Client payment due',
      body: `${payment.clientId?.name || 'Client'} · due ${payment.dueDate}`,
      href: '/payments',
      severity: overdue ? 'danger' : 'warning',
      dueDate: payment.dueDate,
    });
  }

  const invoices = await Invoice.find({
    status: { $in: ['sent', 'partial', 'overdue'] },
    dueDate: { $lte: soon },
  }).populate('clientId', 'name').limit(200);
  for (const invoice of invoices) {
    const overdue = invoice.dueDate < today;
    const key = `${overdue ? 'invoice-overdue' : 'invoice-due'}:${invoice._id}`;
    activeKeys.push(key);
    await upsert(key, {
      type: overdue ? 'invoice_overdue' : 'invoice_due',
      preference: 'invoices',
      title: overdue ? 'Invoice overdue' : 'Invoice due',
      body: `${invoice.number || 'Draft'} · ${invoice.clientId?.name || 'Client'}`,
      href: `/invoices/${invoice._id}`,
      severity: overdue ? 'danger' : 'warning',
      dueDate: invoice.dueDate,
    });
  }

  const projects = await Project.find({
    status: { $nin: ['Completed'] },
    dueDate: { $gte: today, $lte: soon },
  }).limit(100);
  for (const project of projects) {
    const key = `project-deadline:${project._id}:${project.dueDate}`;
    activeKeys.push(key);
    await upsert(key, {
      type: 'project_deadline',
      preference: 'projects',
      title: 'Project deadline',
      body: `${project.name} · ${project.dueDate}`,
      href: '/projects',
      severity: 'warning',
      dueDate: project.dueDate,
    });
  }

  const tasks = await Task.find({
    status: { $ne: 'Completed' },
    dueDate: { $gte: today, $lte: soon },
  }).limit(100);
  for (const task of tasks) {
    const key = `task-due:${task._id}:${task.dueDate}`;
    activeKeys.push(key);
    await upsert(key, {
      type: 'task_pending',
      preference: 'tasks',
      title: 'Task due',
      body: `${task.title} · ${task.dueDate}`,
      href: '/projects',
      severity: 'info',
      dueDate: task.dueDate,
    });
  }

  const events = await CalendarEvent.find({ dateKey: { $gte: today, $lte: soon } }).limit(100);
  for (const event of events) {
    const meetings = event.eventType === 'Client Meeting' || event.eventType === 'Business Meeting';
    const key = `event:${event._id}`;
    activeKeys.push(key);
    await upsert(key, {
      type: meetings ? 'meeting' : 'calendar',
      preference: meetings ? 'meetings' : 'calendar',
      title: meetings ? 'Upcoming meeting' : 'Calendar reminder',
      body: `${event.title} · ${event.dateKey}${event.startTime ? ` ${event.startTime}` : ''}`,
      href: '/calendar',
      severity: 'info',
      dueDate: event.dateKey,
    });
  }

  const salaries = await SalaryRecord.find({ status: 'draft', dueDate: { $lte: soon } }).populate('employeeId', 'fullName').limit(100);
  for (const salary of salaries) {
    const key = `salary-due:${salary._id}`;
    activeKeys.push(key);
    await upsert(key, {
      type: 'salary_due',
      preference: 'salary',
      title: 'Salary due',
      body: `${salary.employeeId?.fullName || 'Employee'} · ${salary.monthKey}`,
      href: '/salary',
      severity: salary.dueDate < today ? 'danger' : 'warning',
      dueDate: salary.dueDate,
    });
  }

  await Notification.updateMany(
    { key: { $nin: activeKeys }, resolved: false },
    { $set: { resolved: true } },
  );
}

async function upsert(key, fields) {
  await Notification.updateOne(
    { key },
    { $set: { ...fields, resolved: false }, $setOnInsert: { key, readBy: [] } },
    { upsert: true },
  );
}
