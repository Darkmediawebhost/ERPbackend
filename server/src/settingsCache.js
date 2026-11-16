import { CompanySettings } from './models.js';

let cached;

export async function getSettings() {
  if (!cached) cached = await CompanySettings.findById('company').lean();
  return (
    cached || {
      companyName: 'DARK MEDIA',
      legalName: 'Dark Media',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      financialYearStartMonth: 4,
      invoicePrefix: 'DM',
      workStart: '10:00',
      lateGraceMinutes: 0,
      weeklyOff: [0],
      reminderDays: 3,
      defaultTaxBps: 0,
      profitSharingActive: false,
      paymentInstructions: '',
      address: '',
      phone: '',
      email: '',
      website: '',
      gstin: '',
      pan: '',
    }
  );
}

export function clearSettingsCache() {
  cached = null;
}
