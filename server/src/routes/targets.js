import { Router } from 'express';
import { z } from 'zod';
import { requirePerm, requireUser } from '../auth.js';
import { addDays, daysInMonth, monthEnd, monthStart, parseYmd, todayKey, weekdayIndex } from '../dates.js';
import { HttpError } from '../errors.js';
import { parse, wrap } from '../http.js';
import { rupeesToPaise } from '../money.js';
import { Target, TargetEntry } from '../models.js';

const router = Router();
router.use(requireUser);
router.use(requirePerm('dashboard.view'));

function weekBounds(today) {
  const weekday = weekdayIndex(today);
  const from = addDays(today, weekday === 0 ? -6 : 1 - weekday);
  return { from, to: addDays(from, 6) };
}

function money(value, label) {
  try {
    const paise = rupeesToPaise(value === '' || value === undefined || value === null ? '0' : value);
    if (paise < 0) throw new HttpError(`${label} cannot be negative`, 400);
    return paise;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(`${label} must be a rupee amount`, 400);
  }
}

async function sumBetween(from, to) {
  const [row] = await TargetEntry.aggregate([
    { $match: { dateKey: { $gte: from, $lte: to } } },
    { $group: { _id: null, amountPaise: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
  ]);
  return { amountPaise: row?.amountPaise || 0, count: row?.count || 0 };
}

async function snapshot() {
  const today = todayKey();
  const week = weekBounds(today);
  const month = { from: monthStart(today), to: monthEnd(today) };
  const saved = await Target.findById('company');
  const targets = {
    dayPaise: saved?.dayPaise || 0,
    weekPaise: saved?.weekPaise || 0,
    monthPaise: saved?.monthPaise || 0,
  };
  const [day, weekActual, monthActual, grouped, entries] = await Promise.all([
    sumBetween(today, today),
    sumBetween(week.from, week.to),
    sumBetween(month.from, month.to),
    TargetEntry.aggregate([
      { $match: { dateKey: { $gte: month.from, $lte: month.to } } },
      { $group: { _id: '$dateKey', amountPaise: { $sum: '$amountPaise' } } },
    ]),
    TargetEntry.find().sort({ createdAt: -1 }).limit(200),
  ]);
  const byDay = new Map(grouped.map((row) => [row._id, row.amountPaise]));
  const { y, m } = parseYmd(today);
  const days = Array.from({ length: daysInMonth(y, m) }, (_, index) => {
    const dateKey = `${month.from.slice(0, 8)}${String(index + 1).padStart(2, '0')}`;
    return { dateKey, amountPaise: byDay.get(dateKey) || 0, future: dateKey > today };
  });
  return {
    today,
    targets,
    periods: [
      { id: 'day', label: 'Today', from: today, to: today, targetPaise: targets.dayPaise, ...day },
      { id: 'week', label: 'This week', ...week, targetPaise: targets.weekPaise, ...weekActual },
      { id: 'month', label: 'This month', ...month, targetPaise: targets.monthPaise, ...monthActual },
    ],
    days,
    entries,
  };
}

router.get('/', wrap(async (_req, res) => {
  res.json({ data: await snapshot() });
}));

router.put('/', wrap(async (req, res) => {
  const body = parse(z.object({
    day: z.union([z.string(), z.number()]),
    week: z.union([z.string(), z.number()]),
    month: z.union([z.string(), z.number()]),
  }), req.body);
  await Target.findByIdAndUpdate('company', {
    dayPaise: money(body.day, 'Daily target'),
    weekPaise: money(body.week, 'Weekly target'),
    monthPaise: money(body.month, 'Monthly target'),
  }, { upsert: true, new: true, setDefaultsOnInsert: true });
  res.json({ data: await snapshot() });
}));

router.post('/entries', wrap(async (req, res) => {
  const body = parse(z.object({
    amount: z.union([z.string(), z.number()]),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: z.string().trim().max(160).optional(),
  }), req.body);
  try { parseYmd(body.date); } catch { throw new HttpError('Enter a real date', 400); }
  const amountPaise = money(body.amount, 'Amount');
  if (amountPaise <= 0) throw new HttpError('Enter an amount greater than zero', 400);
  await TargetEntry.create({
    dateKey: body.date,
    amountPaise,
    note: body.note || '',
    createdBy: req.user._id,
  });
  res.status(201).json({ data: await snapshot() });
}));

router.delete('/entries/:id', wrap(async (req, res) => {
  const entry = await TargetEntry.findById(req.params.id);
  if (!entry) throw new HttpError('That entry was not found', 404);
  await entry.deleteOne();
  res.json({ data: await snapshot() });
}));

export default router;
