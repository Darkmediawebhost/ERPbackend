import ExcelJS from 'exceljs';
import { paiseToRupees } from '../money.js';

export function toCsv(columns, rows) {
  const header = columns.map((column) => csvCell(column.header)).join(',');
  const body = rows.map((row) => columns.map((column) => csvCell(cellValue(column, row))).join(',')).join('\n');
  return `\uFEFF${header}\n${body}`;
}

export async function toXlsx(title, columns, rows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'DARK MEDIA';
  const sheet = workbook.addWorksheet(title.slice(0, 31) || 'Report');
  sheet.columns = columns.map((column) => ({ header: column.header, key: column.key, width: column.width || 22 }));
  for (const row of rows) {
    const record = {};
    for (const column of columns) record[column.key] = cellValue(column, row);
    sheet.addRow(record);
  }
  sheet.getRow(1).font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function cellValue(column, row) {
  const value = row[column.key];
  if (value === undefined || value === null) return '';
  if (column.money) return Number(paiseToRupees(value));
  return value;
}

function csvCell(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
