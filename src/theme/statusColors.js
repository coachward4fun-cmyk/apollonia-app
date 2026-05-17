// Shared status badge palette. Single source of truth for the bg/fg colors
// rendered on job status pills across the app (Jobs, Invoice, etc.).
//
// Status keys are matched case-insensitively. Unknown / missing statuses fall
// back to the neutral grey style via statusStyle().

import { colors } from './colors';

const FALLBACK = { bg: '#f3f4f6', fg: '#6b7280' };

export const STATUS_COLORS = {
  'not scheduled': { bg: '#f3f4f6', fg: '#6b7280' },
  'scheduled':     { bg: '#dbeafe', fg: '#2563eb' },
  'in progress':   { bg: '#dcfce7', fg: colors.primary },
  'invoice ready': { bg: '#dbeafe', fg: '#2563eb' },
  'invoice sent':  { bg: '#fef3c7', fg: '#d97706' },
  'invoice paid':  { bg: '#dcfce7', fg: colors.primary },
  'cancelled':     { bg: '#fee2e2', fg: '#dc2626' },
};

export function statusStyle(status) {
  return STATUS_COLORS[(status || '').toLowerCase()] || FALLBACK;
}
