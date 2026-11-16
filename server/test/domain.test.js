import assert from 'node:assert/strict';
import test from 'node:test';
import { addDays, eachMonth, resolvePreset, weekdayIndex } from '../src/dates.js';
import { assertBalanced, basisPointsFromPercent, capitalFromParts, rupeesToPaise, splitByBasisPoints } from '../src/money.js';

test('rupees convert to integer paise', () => {
  assert.equal(rupeesToPaise('0'), 0);
  assert.equal(rupeesToPaise('10'), 1000);
  assert.equal(rupeesToPaise('10.5'), 1050);
  assert.equal(rupeesToPaise('90000'), 9000000);
  assert.equal(rupeesToPaise('1234.56'), 123456);
  assert.equal(rupeesToPaise('-2.05'), -205);
  assert.throws(() => rupeesToPaise('1.005'));
  assert.throws(() => rupeesToPaise('10.555'));
});

test('journal lines must balance in paise', () => {
  assert.equal(assertBalanced([
    { debitPaise: 150000, creditPaise: 0 },
    { debitPaise: 0, creditPaise: 150000 },
  ]), 150000);
  assert.throws(() => assertBalanced([
    { debitPaise: 100, creditPaise: 0 },
    { debitPaise: 0, creditPaise: 90 },
  ]));
});

test('profit shares use the largest remainder and add back exactly', () => {
  const exact = splitByBasisPoints(9000000, [
    { name: 'Sajeel', bps: 4000 },
    { name: 'Shakeeb', bps: 3000 },
    { name: 'Ismail', bps: 3000 },
  ]);
  assert.deepEqual(exact.map((row) => row.amountPaise), [3600000, 2700000, 2700000]);

  const odd = splitByBasisPoints(1, [
    { name: 'Sajeel', bps: 4000 },
    { name: 'Ismail', bps: 3000 },
    { name: 'Shakeeb', bps: 3000 },
  ]);
  assert.equal(odd.reduce((sum, row) => sum + row.amountPaise, 0), 1);
  assert.equal(odd.find((row) => row.name === 'Sajeel').amountPaise, 1);
});

test('capital is contributions and profit, less withdrawals and loss', () => {
  assert.equal(capitalFromParts({
    investedPaise: 100000,
    personalExpensesPaise: 5000,
    reimbursementsPaise: 2000,
    withdrawalsPaise: 10000,
    profitPaise: 8000,
    lossPaise: 1000,
  }), 100000);
});

test('percentages become basis points', () => {
  assert.equal(basisPointsFromPercent('40'), 4000);
  assert.equal(basisPointsFromPercent('33.33'), 3333);
  assert.equal(basisPointsFromPercent('100'), 10000);
});

test('financial year and month ranges stay on calendar dates', () => {
  const year = resolvePreset('this_year', 'Asia/Kolkata', 4, undefined, undefined);
  assert.equal(year.from.endsWith('-04-01') || year.from < year.to, true);
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(weekdayIndex('2026-11-11'), 3);
  assert.deepEqual(eachMonth('2026-11-30', '2027-01-02'), ['2026-11', '2026-12', '2027-01']);
});
