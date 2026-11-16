import { HttpError } from './errors.js';

const MONEY_PATTERN = /^-?\d+(\.\d{1,2})?$/;
const PERCENT_PATTERN = /^\d+(\.\d{1,2})?$/;

export function rupeesToPaise(value) {
  const raw = String(value ?? '').trim().replace(/,/g, '').replace(/^₹\s*/, '');
  if (!MONEY_PATTERN.test(raw)) {
    throw new Error('Amount must be a rupee value with up to 2 decimal places');
  }
  const negative = raw.startsWith('-');
  const [whole, fraction = ''] = raw.replace('-', '').split('.');
  const paise = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(paise)) throw new Error('Amount is too large');
  return negative ? -paise : paise;
}

export function paiseToRupees(paise) {
  const negative = paise < 0;
  const absolute = Math.abs(paise);
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function formatInr(paise) {
  const negative = paise < 0;
  const absolute = Math.abs(paise);
  const whole = Math.floor(absolute / 100).toLocaleString('en-IN');
  const fraction = String(absolute % 100).padStart(2, '0');
  return `${negative ? '-' : ''}₹${whole}.${fraction}`;
}

export function basisPointsFromPercent(value) {
  const raw = String(value ?? '').trim().replace(/%$/, '');
  if (!PERCENT_PATTERN.test(raw)) {
    throw new Error('Enter a percentage between 0 and 100 with up to 2 decimals');
  }
  const [whole, fraction = ''] = raw.split('.');
  const basisPoints = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (basisPoints > 10000) throw new Error('Percentage cannot exceed 100');
  return basisPoints;
}

export function formatBasisPoints(basisPoints) {
  const whole = Math.floor(basisPoints / 100);
  const fraction = String(basisPoints % 100).padStart(2, '0');
  return `${whole}.${fraction}`;
}

export function assertBalanced(lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new Error('A journal entry needs at least two lines');
  }
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    const debitPaise = line.debitPaise || 0;
    const creditPaise = line.creditPaise || 0;
    if (!Number.isInteger(debitPaise) || !Number.isInteger(creditPaise)) {
      throw new Error('Journal amounts must be integer paise');
    }
    if (debitPaise < 0 || creditPaise < 0) throw new Error('Journal amounts cannot be negative');
    if ((debitPaise > 0 && creditPaise > 0) || (debitPaise === 0 && creditPaise === 0)) {
      throw new Error('Each journal line must be either a debit or a credit');
    }
    debit += debitPaise;
    credit += creditPaise;
  }
  if (debit !== credit) {
    throw new Error(`Unbalanced journal: debits ${debit} paise, credits ${credit} paise`);
  }
  return debit;
}

export function assertFunds(balancePaise, deltaPaise, allowOverdraft, accountName) {
  if (deltaPaise < 0 && !allowOverdraft && balancePaise + deltaPaise < 0) {
    throw new HttpError(`${accountName} does not have enough for this payment. Record money into that account, or choose another one.`);
  }
}

/**
 * Largest-remainder split so the parts always add back to the original paise.
 * `bps` values must already total 10,000.
 */
export function splitByBasisPoints(totalPaise, parties) {
  if (!Number.isInteger(totalPaise)) throw new Error('Amount must be integer paise');
  const basisTotal = parties.reduce((sum, party) => sum + party.bps, 0);
  if (basisTotal !== 10000) throw new Error('Profit shares must total 100%');
  const sign = totalPaise < 0 ? -1 : 1;
  const absolute = Math.abs(totalPaise);
  const rows = parties.map((party) => {
    const product = absolute * party.bps;
    return {
      ...party,
      amountPaise: Math.floor(product / 10000) * sign,
      remainder: product % 10000,
    };
  });
  let leftover = absolute - rows.reduce((sum, row) => sum + Math.abs(row.amountPaise), 0);
  const order = [...rows].sort(
    (left, right) => right.remainder - left.remainder || String(left.name).localeCompare(String(right.name)),
  );
  for (const row of order) {
    if (leftover <= 0) break;
    row.amountPaise += sign;
    leftover -= 1;
  }
  return rows.map(({ remainder, ...party }) => party);
}

export function capitalFromParts(parts) {
  return (
    parts.investedPaise +
    parts.personalExpensesPaise -
    parts.reimbursementsPaise -
    parts.withdrawalsPaise +
    parts.profitPaise -
    parts.lossPaise
  );
}

export function quantityMilli(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,3})?$/.test(raw)) {
    throw new Error('Quantity must be a positive number with up to 3 decimal places');
  }
  const [whole, fraction = ''] = raw.split('.');
  const milli = Number(whole) * 1000 + Number((fraction + '000').slice(0, 3));
  if (!Number.isSafeInteger(milli) || milli <= 0) throw new Error('Quantity must be greater than zero');
  return milli;
}

export function formatQuantity(milli) {
  const whole = Math.floor(milli / 1000);
  const fraction = String(milli % 1000).padStart(3, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function lineAmountPaise(milli, ratePaise) {
  return Math.round((milli * ratePaise) / 1000);
}

export function percentageOf(amountPaise, basisPoints) {
  return Math.round((amountPaise * basisPoints) / 10000);
}
