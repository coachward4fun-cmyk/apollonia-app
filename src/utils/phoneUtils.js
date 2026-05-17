// Phone number normalization for Twilio E.164 format
// E.164: +15312226245 (no dashes, spaces, or parens)

export function normalizePhone(phone) {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (!trimmed) return null;
  if (/^\+\d{10,15}$/.test(trimmed)) return trimmed; // already E.164
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return null; // unrecognizable — caller decides what to do
}

// Formats an E.164 number for display: "+15312226245" → "531-222-6245"
export function formatPhoneDisplay(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  const core = (digits.length === 11 && digits.startsWith('1')) ? digits.slice(1) : digits;
  if (core.length === 10) {
    return `${core.slice(0, 3)}-${core.slice(3, 6)}-${core.slice(6)}`;
  }
  return phone; // return as-is if non-standard
}
