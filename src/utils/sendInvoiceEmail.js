import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { Asset } from 'expo-asset';
import { logActivity } from '../services/activityLog';
import { getCompanyProfile } from '../services/db';

const SEND_EMAIL_URL = 'https://us-central1-apollonia-construction.cloudfunctions.net/sendInvoiceEmail';

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDecimal(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(str) {
  if (!str) return '—';
  const d = new Date(str + 'T00:00:00');
  if (isNaN(d)) return str;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function calcTotals(lineItems, taxRateNum = 7) {
  const subtotal = lineItems.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unitPrice) || 0), 0);
  const tax      = subtotal * (taxRateNum / 100);
  return { subtotal, tax, total: subtotal + tax };
}

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Extract filename and upload date from a Firebase Storage download URL.
function extractPhotoMeta(photoUrl) {
  try {
    const oIdx = photoUrl.indexOf('/o/');
    if (oIdx === -1) return { filename: 'photo.jpg', dateStr: '' };
    const encoded = photoUrl.slice(oIdx + 3).split('?')[0];
    const decoded = decodeURIComponent(encoded);
    const filename = decoded.split('/').pop() || 'photo.jpg';
    const tsStr = filename.split('_')[0];
    const ts = parseInt(tsStr, 10);
    const dateStr = ts > 1_000_000_000_000
      ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
    return { filename, dateStr };
  } catch {
    return { filename: 'photo.jpg', dateStr: '' };
  }
}

// ── Photo pages HTML ───────────────────────────────────────────────────────────

function buildPhotoPages(photoData, job = {}) {
  if (!photoData || photoData.length === 0) return '';

  // Heading on the first photo page identifies which job these photos belong to.
  const headingParts = [];
  if (job.jobId)       headingParts.push(`Job ${escapeHtml(job.jobId)}`);
  if (job.targetDate)  headingParts.push(escapeHtml(formatDate(job.targetDate)));
  if (job.projectName) headingParts.push(escapeHtml(job.projectName));
  const heading = headingParts.length
    ? `Job Site Photos for ${headingParts.join(' · ')}`
    : 'Job Site Photos';

  const PHOTOS_PER_PAGE = 8;
  let html = '';

  for (let start = 0; start < photoData.length; start += PHOTOS_PER_PAGE) {
    const group = photoData.slice(start, start + PHOTOS_PER_PAGE);
    const isFirst = start === 0;

    const rows = [];
    for (let r = 0; r < 4; r++) {
      const p1 = group[r * 2];
      const p2 = group[r * 2 + 1];

      const cell = (p) => {
        if (!p) {
          return '<td style="width:50%;padding:8px;box-sizing:border-box;"></td>';
        }
        const caption = p.filename + (p.dateStr ? ' · ' + p.dateStr : '');
        return `
          <td style="width:50%;padding:8px;box-sizing:border-box;vertical-align:top;">
            <img src="data:image/jpeg;base64,${p.base64}"
                 style="width:100%;height:190px;object-fit:cover;display:block;border-radius:4px;" />
            <div style="font-size:9px;color:#9ca3af;margin-top:3px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">${escapeHtml(caption)}</div>
          </td>`;
      };

      rows.push(`<tr>${cell(p1)}${cell(p2)}</tr>`);
    }

    html += `
      <div style="page-break-before:always;break-before:page;">
        ${isFirst
          ? `<div style="font-size:15px;font-weight:700;color:#111827;margin-bottom:14px;padding-bottom:8px;border-bottom:2px solid #e5e7eb;letter-spacing:0.3px;">${heading}</div>`
          : ''}
        <table style="width:100%;table-layout:fixed;border-collapse:collapse;">${rows.join('')}</table>
      </div>`;
  }

  return html;
}

// ── Invoice HTML ───────────────────────────────────────────────────────────────

// logoSrc may be a public URL (e.g. https://firebasestorage…) or a data: URI.
// PDFs use a data: URI so the image embeds offline; email HTML uses the public
// URL so Gmail / iCloud Mail render it (those clients strip data: image src).
function buildInvoiceHTML(job, invoiceNumber, invDate, dueDate, lineItems, footerNote = '', logoSrc = '', extraPages = '', profile = {}) {
  const taxRateNum = job.taxRate != null ? job.taxRate : 0;
  const taxLabel   = job.taxLabel || '';
  const taxDisplay = `${taxRateNum}%${taxLabel ? ` - ${taxLabel}` : ''}`;
  const { subtotal, tax, total } = calcTotals(lineItems, taxRateNum);
  const visibleItems = lineItems.filter((i) => (Number(i.qty) || 0) > 0);

  const companyName  = escapeHtml(profile.companyName  || '');
  const companyAddr  = escapeHtml(profile.address      || '');
  const companyPhone = escapeHtml(profile.phone        || '');
  const billingEmail = escapeHtml(profile.billingEmail || '');
  const tagline      = escapeHtml(profile.tagline      || '');

  const itemRows = visibleItems.map((item) => {
    const lt = (Number(item.qty) || 0) * (Number(item.unitPrice) || 0);
    return `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-size:10pt;color:#111827;">${item.description}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-size:10pt;text-align:center;color:#374151;">${item.qty}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-size:10pt;text-align:right;color:#374151;">${fmtDecimal(item.unitPrice)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-size:10pt;text-align:right;font-weight:600;color:#111827;">${fmtDecimal(lt)}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Invoice ${invoiceNumber}</title>
  <style>
    @page { size: letter; margin: 0.5in; }
    @media print { * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">

  <!-- Invoice card — page 1 -->
  <div style="max-width:680px;margin:0 auto;background:#fff;">

    <!-- Header (green bar) — logo flush left, tagline centered in the space to its right -->
    <div style="background:#16a34a;padding:0;height:50px;">
      <table style="width:100%;height:50px;border-collapse:collapse;"><tr>
        <td style="vertical-align:middle;text-align:left;width:1px;white-space:nowrap;padding:0 8px 0 0;">
          ${logoSrc
            ? `<img src="${logoSrc}" style="height:50px;max-width:200px;display:block;" alt="${companyName}" />`
            : `<div style="padding:0 24px;"><div style="font-size:18px;font-weight:800;color:#fff;">${companyName}</div>${companyAddr ? `<div style="font-size:12px;color:#bbf7d0;margin-top:2px;">${companyAddr}</div>` : ''}</div>`
          }
        </td>
        <td style="vertical-align:middle;text-align:center;padding:0 24px;">
          ${tagline
            ? `<div style="font-size:22px;font-weight:800;font-style:italic;color:#fff;letter-spacing:0.3px;line-height:1.2;">&ldquo;${tagline}&rdquo;</div>`
            : ''}
        </td>
      </tr></table>
    </div>

    <!-- Body -->
    <div style="padding:8px 32px;">

      <!-- Bill-to + Invoice meta -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:0;">
        <tr>
          <td style="vertical-align:top;width:55%;">
            <div style="font-size:9pt;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;">Bill To</div>
            <div style="font-size:15px;font-weight:700;color:#111827;">${job.billToName || ''}</div>
            ${(job.billToAddress || job.email)
              ? `<div style="font-size:13px;color:#6b7280;margin-top:4px;">${[job.billToAddress, job.email].filter(Boolean).join('&nbsp;&nbsp;')}</div>`
              : ''}
          </td>
          <td style="vertical-align:top;text-align:right;">
            <table style="margin-left:auto;border-collapse:collapse;">
              <tr>
                <td style="font-size:12px;color:#9ca3af;padding:3px 0;padding-right:12px;">Invoice #</td>
                <td style="font-size:12px;font-weight:600;color:#111827;padding:3px 0;">${invoiceNumber}</td>
              </tr>
              <tr>
                <td style="font-size:12px;color:#9ca3af;padding:3px 0;padding-right:12px;">Invoice Date</td>
                <td style="font-size:12px;font-weight:600;color:#111827;padding:3px 0;">${formatDate(invDate)}</td>
              </tr>
              <tr>
                <td style="font-size:12px;color:#9ca3af;padding:3px 0;padding-right:12px;">Due Date</td>
                <td style="font-size:12px;font-weight:600;color:#111827;padding:3px 0;">${formatDate(dueDate)}</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

      <!-- Project -->
      <div style="background:#f0fdf4;border-radius:8px;padding:8px 16px;margin-bottom:8px;border-left:4px solid #16a34a;">
        <div style="font-size:9pt;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px;">Project</div>
        <div style="font-size:14px;color:#111827;line-height:1.4;">
          ${job.jobId ? `<span style="font-weight:600;color:#6b7280;font-family:monospace;margin-right:8px;">Job ${escapeHtml(job.jobId)}</span>` : ''}
          <span style="font-weight:700;">${job.projectName || ''}</span>
          ${job.targetDate ? `<span style="color:#6b7280;margin-left:8px;">· ${formatDate(job.targetDate)}</span>` : ''}
        </div>
        ${job.jobLocationAddress ? `<div style="font-size:13px;color:#6b7280;margin-top:4px;">${job.jobLocationAddress}</div>` : ''}
      </div>

      <!-- Line items -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:8px 12px;text-align:left;font-size:9pt;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e5e7eb;">Description</th>
            <th style="padding:8px 12px;text-align:center;font-size:9pt;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e5e7eb;width:50px;">Qty</th>
            <th style="padding:8px 12px;text-align:right;font-size:9pt;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e5e7eb;width:80px;">Unit Price</th>
            <th style="padding:8px 12px;text-align:right;font-size:9pt;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e5e7eb;width:80px;">Total</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>

      <!-- Bottom: Send Payment To (left) + Totals (right) -->
      <table style="width:100%;border-collapse:collapse;margin-top:8px;border-top:2px solid #e5e7eb;">
        <tr>
          <td style="vertical-align:top;width:50%;padding-right:24px;padding-top:8px;">
            <div style="font-size:9pt;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;">Send Payment To</div>
            <div style="font-size:14px;font-weight:700;color:#111827;">${companyName}</div>
            ${companyAddr  ? `<div style="font-size:13px;color:#6b7280;margin-top:3px;">${companyAddr}</div>`  : ''}
            ${billingEmail ? `<div style="font-size:13px;color:#6b7280;margin-top:2px;">${billingEmail}</div>` : ''}
            ${companyPhone ? `<div style="font-size:13px;color:#6b7280;margin-top:2px;">${companyPhone}</div>` : ''}
          </td>
          <td style="vertical-align:top;padding-top:8px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr>
                <td style="padding:5px 0;font-size:13px;color:#6b7280;">Subtotal</td>
                <td style="padding:5px 0;font-size:13px;color:#111827;text-align:right;">${fmtDecimal(subtotal)}</td>
              </tr>
              <tr>
                <td style="padding:5px 0;font-size:13px;color:#6b7280;">Tax (${taxDisplay})</td>
                <td style="padding:5px 0;font-size:13px;color:#111827;text-align:right;">${fmtDecimal(tax)}</td>
              </tr>
              <tr>
                <td colspan="2"><hr style="border:none;border-top:2px solid #e5e7eb;margin:6px 0;"></td>
              </tr>
              <tr>
                <td style="padding:4px 0;font-size:15px;font-weight:800;color:#111827;">Total Due</td>
                <td style="padding:4px 0;font-size:17px;font-weight:800;color:#16a34a;text-align:right;">${fmtDecimal(total)}</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
      ${footerNote ? `<div style="margin-top:16px;">${footerNote}</div>` : ''}

    </div>

  </div>

  ${extraPages}

</body>
</html>`;
}

// ── Main export ────────────────────────────────────────────────────────────────

// Max photos embedded inside the email PDF. Any beyond this are mentioned in
// a footer rather than embedded — keeps the PDF small and the Cloud Function
// payload under timeout.
// Matches the per-job photo cap enforced in JobFormScreen, so every uploaded
// photo gets embedded directly in the PDF.
const MAX_EMBEDDED_PHOTOS = 25;

async function downloadAndCompressPhoto(photoUrl) {
  let tmpUri    = null;
  let resizedUri = null;
  try {
    const { filename, dateStr } = extractPhotoMeta(photoUrl);

    tmpUri = FileSystem.cacheDirectory + 'pdf_p_' + Math.random().toString(36).slice(2) + '.jpg';
    const dl = await FileSystem.downloadAsync(photoUrl, tmpUri);
    if (dl.status !== 200) return null;

    const result = await ImageManipulator.manipulateAsync(
      tmpUri,
      [{ resize: { width: 500 } }], // Item #7 — 500 px is plenty for PDF render
      { compress: 0.65, format: ImageManipulator.SaveFormat.JPEG },
    );
    resizedUri = result.uri;

    const base64 = await FileSystem.readAsStringAsync(resizedUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return { base64, filename, dateStr };
  } catch {
    return null;
  } finally {
    if (tmpUri)                              FileSystem.deleteAsync(tmpUri,     { idempotent: true }).catch(() => {});
    if (resizedUri && resizedUri !== tmpUri) FileSystem.deleteAsync(resizedUri, { idempotent: true }).catch(() => {});
  }
}

export async function sendInvoiceEmail(job, invoiceNumber, invDate, dueDate, lineItems, { onProgress } = {}) {
  const toEmail = job.email;
  if (!toEmail) throw new Error('No email address on file for this customer.');

  // ── Load company profile ──
  let profile = {};
  try {
    profile = await getCompanyProfile();
  } catch (err) {
    console.warn('[Invoice] could not load company profile:', err.message);
  }

  // ── Load logo: prefer profile.logoUrl from Firebase Storage; fall back to bundled asset ──
  let logoBase64 = '';
  let logoMime   = 'image/png';
  if (profile.logoUrl) {
    let tmpUri = null;
    try {
      tmpUri = FileSystem.cacheDirectory + 'company_logo_' + Date.now() + '.jpg';
      const dl = await FileSystem.downloadAsync(profile.logoUrl, tmpUri);
      if (dl.status === 200) {
        logoBase64 = await FileSystem.readAsStringAsync(tmpUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        logoMime = 'image/jpeg'; // uploadCompanyLogo always produces JPEG
      }
    } catch (err) {
      console.warn('[Invoice] logo download failed:', err.message);
    } finally {
      if (tmpUri) FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
    }
  }
  if (!logoBase64) {
    try {
      const [logoAsset] = await Asset.loadAsync(require('../../assets/Apollonia_new.png'));
      if (logoAsset.localUri) {
        logoBase64 = await FileSystem.readAsStringAsync(logoAsset.localUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        logoMime = 'image/png';
      }
    } catch { /* logo is optional */ }
  }

  // ── Download and compress photos in parallel ──
  // All uploaded photos (up to MAX_EMBEDDED_PHOTOS) are embedded directly.
  const allPhotoUrls = (job.photos || []).filter(Boolean);
  const embedUrls    = allPhotoUrls.slice(0, MAX_EMBEDDED_PHOTOS);

  const totalToEmbed = embedUrls.length;
  let completed = 0;
  onProgress?.(0, totalToEmbed);

  const photoData = (
    await Promise.all(embedUrls.map(async (url) => {
      const data = await downloadAndCompressPhoto(url);
      completed++;
      onProgress?.(completed, totalToEmbed);
      return data;
    }))
  ).filter(Boolean);

  // ── Logo sources ──
  // PDF embeds the base64 data URI so it renders offline inside the file.
  // Email uses the public Firebase Storage URL when available, because Gmail
  // and most other clients strip inline data: image src for security.
  const pdfLogoSrc   = logoBase64 ? `data:${logoMime};base64,${logoBase64}` : '';
  const emailLogoSrc = profile.logoUrl || pdfLogoSrc;

  // ── Generate PDF (invoice + photo pages) ──
  let pdfBase64 = null;
  let pdfUri    = null;
  try {
    const photoPages = buildPhotoPages(photoData, job);
    const pdfHtml    = buildInvoiceHTML(job, invoiceNumber, invDate, dueDate, lineItems, '', pdfLogoSrc, photoPages, profile);
    const { uri }    = await Print.printToFileAsync({ html: pdfHtml, base64: false });
    pdfUri    = uri;
    pdfBase64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  } catch (pdfErr) {
    console.warn('[Invoice] PDF generation failed:', pdfErr.message);
  } finally {
    if (pdfUri) FileSystem.deleteAsync(pdfUri, { idempotent: true }).catch(() => {});
  }

  // ── Build email HTML body ──
  const n = photoData.length;
  const footerNote = n > 0
    ? `<p style="font-size:13px;color:#6b7280;margin-top:16px;">${n} job site photo${n !== 1 ? 's' : ''} included on page${n > 8 ? 's' : ''} 2+ of the attached PDF.</p>`
    : '';
  const emailHtml = buildInvoiceHTML(job, invoiceNumber, invDate, dueDate, lineItems, footerNote, emailLogoSrc, '', profile);

  const companyShort = profile.companyName || 'Invoice';
  const subject      = `${companyShort} Invoice - ${job.projectName || invoiceNumber}`;

  // ── Plain-text version ──
  const visibleItems    = lineItems.filter((i) => (Number(i.qty) || 0) > 0);
  const emailTaxRate    = job.taxRate != null ? job.taxRate : 0;
  const emailTaxLabel   = job.taxLabel || '';
  const emailTaxDisplay = `${emailTaxRate}%${emailTaxLabel ? ` - ${emailTaxLabel}` : ''}`;
  const { subtotal, tax, total } = calcTotals(lineItems, emailTaxRate);
  const itemLines = visibleItems.map(
    (i) => `  ${i.description.padEnd(40)} ${String(i.qty).padStart(4)} x ${fmtDecimal(i.unitPrice).padStart(9)} = ${fmtDecimal((Number(i.qty) || 0) * (Number(i.unitPrice) || 0))}`,
  ).join('\n');

  const profileSupport = profile.supportEmail || '';
  const headerLine = profile.companyName
    ? (profile.address ? `${profile.companyName} — ${profile.address}` : profile.companyName)
    : '';

  const plainText = [
    `INVOICE #${invoiceNumber}`,
    headerLine,
    '',
    `Invoice Date : ${formatDate(invDate)}`,
    `Due Date     : ${formatDate(dueDate)}`,
    '',
    `Send Payment To`,
    `---------------`,
    profile.companyName  || '',
    profile.address      || '',
    profile.billingEmail || '',
    profile.phone        || '',
    '',
    `Bill To`,
    `-------`,
    job.billToName    || '',
    job.billToAddress || '',
    job.email         || '',
    '',
    `Project`,
    `-------`,
    job.projectName        || '',
    job.jobLocationAddress || '',
    job.targetDate ? `Job Date: ${formatDate(job.targetDate)}` : '',
    '',
    `Line Items`,
    `----------`,
    itemLines,
    '',
    `Subtotal : ${fmtDecimal(subtotal)}`,
    `Tax (${emailTaxDisplay}) : ${fmtDecimal(tax)}`,
    `─────────────────────`,
    `Total Due: ${fmtDecimal(total)}`,
    '',
    n > 0 ? `${n} job site photo${n !== 1 ? 's' : ''} included in the attached PDF.` : '',
    '',
    `Please remit payment by ${formatDate(dueDate)}.`,
    profileSupport
      ? `Questions? Reply to this email or contact ${profileSupport}.`
      : `Questions? Reply to this email.`,
    '',
    profile.companyName ? `This invoice was sent by ${profile.companyName}.` : '',
    `To stop receiving invoices, reply with "unsubscribe".`,
  ].filter((l) => l !== undefined).join('\n');

  // ── Send via Cloud Function (direct fetch — no Firebase Auth required) ──
  try {
    const response = await fetch(SEND_EMAIL_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        to:        toEmail,
        subject,
        htmlBody:  emailHtml,
        text:      plainText,
        pdfBase64: pdfBase64 || null,
        fileName:  `Invoice-${invoiceNumber}.pdf`,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    logActivity('invoice_emailed', `Invoice #${invoiceNumber} - Gmail SMTP - To: ${toEmail}`);
    return { ok: true };
  } catch (err) {
    const message = err?.message || 'Email send failed';
    logActivity('invoice_email_failed', `Invoice #${invoiceNumber} - Error: ${message}`);
    throw new Error(message);
  }
}
