import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { formatInr, paiseToRupees } from '../money.js';
import { StoredFile } from '../models.js';

const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets');

function createDocument(size = 'A4', margin = 48) {
  const doc = new PDFDocument({ size, margin });
  const regular = path.join(assets, 'NotoSans-Regular.ttf');
  const bold = path.join(assets, 'NotoSans-Bold.ttf');
  const embedded = fs.existsSync(regular) && fs.existsSync(bold);
  if (embedded) {
    doc.registerFont('Body', regular);
    doc.registerFont('Bold', bold);
  }
  return {
    doc,
    body: embedded ? 'Body' : 'Helvetica',
    bold: embedded ? 'Bold' : 'Helvetica-Bold',
    rupee: embedded,
  };
}

function money(value, embedded) {
  return embedded ? formatInr(value) : `INR ${paiseToRupees(value)}`;
}

export function renderPdf(draw, options = {}) {
  return new Promise((resolve, reject) => {
    const context = createDocument(options.size, options.margin);
    const chunks = [];
    context.doc.on('data', (chunk) => chunks.push(chunk));
    context.doc.on('end', () => resolve(Buffer.concat(chunks)));
    context.doc.on('error', reject);
    Promise.resolve(draw(context)).then(() => context.doc.end()).catch(reject);
  });
}

function header(context, settings, kicker) {
  const { doc, body, bold } = context;
  doc.rect(0, 0, doc.page.width, 78).fill('#111111');
  doc.rect(0, 78, doc.page.width, 3).fill('#92E622');
  doc.fillColor('#FFFFFF').font(bold).fontSize(18).text(settings.companyName || 'DARK MEDIA', 48, 28, { lineBreak: false });
  doc.font(body).fontSize(10).fillColor('#A3A3A3').text(kicker, 360, 32, { width: 187, align: 'right' });
  doc.fillColor('#111111');
  doc.y = 104;
}

function billDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

function plainAmount(paise) {
  const absolute = Math.abs(Number(paise || 0));
  return `${Math.floor(absolute / 100).toLocaleString('en-IN')}.${String(absolute % 100).padStart(2, '0')}`;
}

export async function invoicePdf({ invoice, items, client, settings }) {
  return renderPdf(async ({ doc, body, bold }) => {
    const width = 306;
    const gradient = doc.linearGradient(0, 0, 0, 132);
    gradient.stop(0, '#05070d').stop(1, '#16345c');
    doc.rect(0, 0, width, 148).fill(gradient);
    doc.circle(28, 28, 10).fill('#ffffff');
    doc.circle(28, 28, 10).lineWidth(10).strokeColor('#111111').stroke();
    doc.fillColor('#ffffff').font(bold).fontSize(11).text('Dark', 44, 18, { lineBreak: false });
    doc.text('Media', 44, 31, { lineBreak: false });
    doc.font(body).fontSize(8).text(settings.website || 'www.darkmedia.tech', 150, 22, { width: 140, align: 'right' });
    doc.font(bold).fontSize(26).text('INVOICE', 16, 62, { lineBreak: false });
    doc.font(body).fontSize(8).text(`No. ${invoice.number || 'Draft'}`, 16, 94);
    doc.font(body).fontSize(8).text('Date:', 210, 70, { width: 80, align: 'right' });
    doc.text(billDate(invoice.dateKey), 210, 84, { width: 80, align: 'right' });

    doc.roundedRect(14, 118, 134, 96, 12).fill('#ffffff');
    doc.roundedRect(158, 118, 134, 96, 12).fill('#ffffff');
    doc.fillColor('#111111').font(body).fontSize(8).text('Invoice To:', 24, 128);
    doc.font(bold).fontSize(11).fillColor('#16345c').text(client?.name || '', 24, 142, { width: 114 });
    doc.font(body).fontSize(7).fillColor('#737373');
    doc.text(`Phone: ${client?.phone || ''}`, 24, 164, { width: 114 });
    doc.text(`Email: ${client?.email || ''}`, 24, 176, { width: 114 });
    doc.text(`Website: ${client?.companyName || ''}`, 24, 188, { width: 114 });
    doc.fillColor('#111111').font(body).fontSize(8).text('Payment Method:', 168, 128);
    doc.font(bold).fontSize(8).text('GPay  ·  Paytm  ·  PhonePe', 168, 146, { width: 114 });
    doc.font(body).fontSize(8).text(settings.phone || '9480889252', 168, 162);
    doc.fillColor('#737373').fontSize(7).text(`Due Date: ${billDate(invoice.dueDate)}`, 168, 184, { width: 114 });

    doc.roundedRect(16, 230, 36, 16, 8).fill('#5BA4D6');
    doc.roundedRect(56, 230, 150, 16, 8).fill('#5BA4D6');
    doc.roundedRect(214, 230, 76, 16, 8).fill('#111111');
    doc.fillColor('#ffffff').font(bold).fontSize(7);
    doc.text('No.', 16, 234, { width: 36, align: 'center' });
    doc.text('DESCRIPTION', 64, 234, { width: 130 });
    doc.text('TOTAL', 214, 234, { width: 76, align: 'center' });

    const slots = Math.max(6, items.length);
    doc.fillColor('#111111').font(body).fontSize(8);
    for (let index = 0; index < slots; index += 1) {
      const item = items[index];
      const y = 256 + index * 16;
      doc.text(String(index + 1).padStart(2, '0'), 18, y, { width: 28 });
      doc.text(item?.description || '', 56, y, { width: 150 });
      doc.text(item ? plainAmount(item.amountPaise) : '', 214, y, { width: 70, align: 'right' });
    }
    const totalY = 256 + slots * 16 + 8;
    doc.roundedRect(150, totalY, 140, 20, 10).fill('#5BA4D6');
    doc.fillColor('#ffffff').font(bold).fontSize(9);
    doc.text('TOTAL', 162, totalY + 6, { width: 50 });
    doc.text(plainAmount(invoice.totalPaise), 214, totalY + 6, { width: 66, align: 'right' });

    const termsY = totalY + 32;
    doc.roundedRect(14, termsY, 278, 72, 12).fill('#ffffff');
    doc.fillColor('#111111').font(bold).fontSize(7).text('Payment Terms', 24, termsY + 8);
    doc.font(body).fontSize(6).fillColor('#525252');
    doc.text('Payment must be made as per the agreed terms.\nAdvance payments are non-refundable once work begins.\nExtra work or revisions will be charged separately.', 24, termsY + 20, { width: 124 });
    doc.text('GST and third-party charges are additional, where applicable.\nFinal files/project handover will be provided after full payment.\nAny invoice dispute must be raised within 7 days.', 156, termsY + 20, { width: 124 });
    doc.fillColor('#8a8a8a').font(bold).fontSize(8).text('THANK YOU FOR YOUR BUSINESS', 14, termsY + 84, { width: 278, align: 'center' });
  }, { size: [306, Math.max(450, 420 + Math.max(6, items.length) * 16)], margin: 0 });
}

export async function salarySlipPdf({ salary, employee, settings }) {
  return renderPdf(({ doc, body, bold, rupee }) => {
    header({ doc, body, bold }, settings, 'SALARY SLIP');
    doc.font(bold).fontSize(14).fillColor('#111111').text(employee.fullName, 48, 110);
    doc.font(body).fontSize(10).fillColor('#737373').text(`${employee.designation || 'Employee'} · ${salary.monthKey}`, 48, 130);
    const rows = [
      ['Base salary', salary.basePaise],
      ['Bonus', salary.bonusPaise],
      ['Deduction', salary.deductionPaise],
      ['Advance recovered', salary.advanceRecoveryPaise],
      ['Net paid', salary.netPaise],
    ];
    let y = 180;
    for (const [label, value] of rows) {
      doc.font(label === 'Net paid' ? bold : body).fontSize(11).fillColor('#111111');
      doc.text(label, 48, y);
      doc.text(money(value || 0, rupee), 360, y, { width: 180, align: 'right' });
      y += 24;
    }
    doc.font(body).fontSize(9).fillColor('#737373').text(`Status: ${salary.status}${salary.paidDate ? ` · paid ${salary.paidDate}` : ''}`, 48, y + 12);
  });
}

export function reportPdf(report) {
  return renderPdf(({ doc, body, bold, rupee }) => {
    header({ doc, body, bold }, { companyName: 'DARK MEDIA' }, 'REPORT');
    doc.font(bold).fontSize(16).fillColor('#111111').text(report.title, 48, 104);
    doc.font(body).fontSize(9).fillColor('#737373').text(`${report.range?.from || ''} to ${report.range?.to || ''}`, 48, 128);
    let y = 156;
    doc.font(bold).fontSize(8).fillColor('#111111');
    const columns = report.columns.slice(0, 6);
    const width = 499 / columns.length;
    columns.forEach((column, index) => {
      doc.text(column.header, 48 + index * width, y, { width: width - 6, lineBreak: false });
    });
    y += 18;
    doc.moveTo(48, y).lineTo(547, y).strokeColor('#111111').stroke();
    y += 8;
    doc.font(body).fontSize(8).fillColor('#111111');
    for (const row of report.rows.slice(0, 28)) {
      if (y > 760) break;
      columns.forEach((column, index) => {
        const value = column.money ? money(row[column.key] || 0, rupee) : String(row[column.key] ?? '');
        doc.text(value, 48 + index * width, y, { width: width - 6, height: 14, ellipsis: true, lineBreak: false });
      });
      y += 16;
    }
    if (report.rows.length > 28) {
      doc.fillColor('#737373').text('Export Excel or CSV for the full report.', 48, y + 8);
    }
  });
}
