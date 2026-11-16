import { Router } from 'express';
import { requirePerm, requireUser } from '../auth.js';
import { rangeFromQuery } from '../dates.js';
import { wrap } from '../http.js';
import { toCsv, toXlsx } from '../services/export.js';
import { reportPdf } from '../services/pdf.js';
import { buildReport } from '../services/reports.js';
import { getSettings } from '../settingsCache.js';

const router = Router();
router.use(requireUser, requirePerm('reports.view'));

export const REPORTS = [
  ['profit-loss', 'Profit and loss'],
  ['income', 'Income'],
  ['expense', 'Expenses'],
  ['cash-flow', 'Cash flow'],
  ['bank-statement', 'Bank statement'],
  ['balance-sheet', 'Balance sheet'],
  ['trial-balance', 'Trial balance'],
  ['general-ledger', 'General ledger'],
  ['receivables', 'Client receivables'],
  ['payables', 'Payables'],
  ['founder-capital', 'Co-founder capital'],
  ['profit-distribution', 'Profit distribution'],
  ['clients', 'Clients'],
  ['projects', 'Projects'],
  ['tasks', 'Tasks'],
  ['attendance', 'Attendance'],
  ['salary', 'Salary'],
  ['invoices', 'Invoices'],
];

router.get('/', (_req, res) => {
  res.json({ data: REPORTS.map(([id, label]) => ({ id, label })) });
});

router.get('/:name', wrap(async (req, res) => {
  const settings = await getSettings();
  const range = rangeFromQuery(req.query, settings);
  const report = await buildReport(req.params.name, range, req.query);
  const format = req.query.format || 'json';
  if (format !== 'json' && req.user.role !== 'master_admin' && !req.user.permissions?.includes('reports.export')) {
    return res.status(403).json({ error: 'You do not have permission to export reports' });
  }
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${report.name}.csv"`);
    return res.send(toCsv(report.columns, report.rows));
  }
  if (format === 'xlsx') {
    const buffer = await toXlsx(report.title, report.columns, report.rows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${report.name}.xlsx"`);
    return res.send(buffer);
  }
  if (format === 'pdf') {
    const buffer = await reportPdf(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${report.name}.pdf"`);
    return res.send(buffer);
  }
  res.json({ data: report });
}));

export default router;
