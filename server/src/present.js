export function presentBank(bank, { reveal = false } = {}) {
  const plain = typeof bank.toObject === 'function' ? bank.toObject() : { ...bank };
  const number = plain.accountNumber || '';
  plain.accountNumberMasked = number ? `•••• ${String(number).slice(-4)}` : '';
  if (!reveal) delete plain.accountNumber;
  return plain;
}
