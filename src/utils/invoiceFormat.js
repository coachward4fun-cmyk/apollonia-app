// Pure formatting + tax-detection helpers shared by InvoiceScreen and the
// invoice email/PDF generator. Side-effect-free so they can be tested in
// isolation; no React or React Native imports.

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(dateStr, n) {
  try {
    const d = new Date((dateStr || today()) + 'T00:00:00');
    if (isNaN(d)) throw new Error('invalid');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  } catch {
    const d = new Date(today() + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }
}

export function formatDate(str) {
  if (!str) return '—';
  const d = new Date(str + 'T00:00:00');
  if (isNaN(d)) return str;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtWhole(n) {
  if (!n && n !== 0) return '$0';
  return '$' + Math.round(Number(n)).toLocaleString('en-US');
}

export function fmtDecimal(n) {
  if (!n && n !== 0) return '$0.00';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function lineTotal(item) {
  return (parseFloat(item.qty) || 0) * (parseFloat(item.unitPrice) || 0);
}

export function calcTotals(items, taxRateNum = 7) {
  const subtotal = items.reduce((s, item) => s + lineTotal(item), 0);
  const tax      = subtotal * (taxRateNum / 100);
  const total    = subtotal + tax;
  return { subtotal, tax, total };
}

export function detectTaxRate(address, rates) {
  const r = rates || {};
  const fallback = r.omaha ?? 0;
  if (!address) return { rate: fallback, label: '' };
  const addr = address.toUpperCase();
  const inNE = /\bNE\b/.test(addr) || addr.includes('NEBRASKA');
  const inIA = /\bIA\b/.test(addr) || addr.includes('IOWA');
  const inSD = /\bSD\b/.test(addr) || addr.includes('SOUTH DAKOTA');
  const inMO = /\bMO\b/.test(addr) || addr.includes('MISSOURI');
  const inKS = /\bKS\b/.test(addr) || addr.includes('KANSAS');
  if (inNE) {
    if (addr.includes('OMAHA')) return { rate: r.omaha    ?? 0, label: 'Omaha NE' };
    return                             { rate: r.nebraska ?? 0, label: 'Nebraska' };
  }
  if (inIA) return { rate: r.iowa        ?? 0, label: 'Iowa' };
  if (inSD) return { rate: r.southDakota ?? 0, label: 'South Dakota' };
  if (inMO) return { rate: r.missouri    ?? 0, label: 'Missouri' };
  if (inKS) return { rate: r.kansas      ?? 0, label: 'Kansas' };
  return { rate: fallback, label: '' };
}
