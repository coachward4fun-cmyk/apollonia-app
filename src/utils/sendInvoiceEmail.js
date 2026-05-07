/**
 * Sends an invoice email via the SendGrid v3 REST API.
 *
 * NOTE: The API key is embedded here for a single-user internal app.
 * For a multi-user or App Store release, move this to a server-side
 * proxy so the key isn't extractable from the app bundle.
 */
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { Asset } from 'expo-asset';

const SENDGRID_URL  = 'https://api.sendgrid.com/v3/mail/send';
const API_KEY       = 'REDACTED_SENDGRID_KEY';
const FROM_EMAIL    = 'claudioroma999@gmail.com';
const FROM_NAME     = 'Kleodian Nazeraj - Apollonia Construction LLC';
const REPLY_TO      = 'claudioroma999@gmail.com';
const CC_EMAILS     = ['claudioroma999@gmail.com', 'apolloniaconstructionllc@gmail.com'];
const TAX_RATE      = 0.07;

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDecimal(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtWhole(n) {
  return '$' + Math.round(Number(n || 0)).toLocaleString('en-US');
}

function formatDate(str) {
  if (!str) return '—';
  const d = new Date(str + 'T00:00:00');
  if (isNaN(d)) return str;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function calcTotals(lineItems) {
  const subtotal = lineItems.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unitPrice) || 0), 0);
  const tax      = subtotal * TAX_RATE;
  return { subtotal, tax, total: subtotal + tax };
}

// ── HTML templates ─────────────────────────────────────────────────────────────

function buildInvoiceHTML(job, invoiceNumber, invDate, dueDate, lineItems, photoNote = '', logoBase64 = '') {
  const { subtotal, tax, total } = calcTotals(lineItems);
  const visibleItems = lineItems.filter((i) => (Number(i.qty) || 0) > 0);

  const itemRows = visibleItems.map((item) => {
    const lt = (Number(item.qty) || 0) * (Number(item.unitPrice) || 0);
    return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;color:#111827;">${item.description}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;text-align:center;color:#374151;">${item.qty}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;text-align:right;color:#374151;">${fmtDecimal(item.unitPrice)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;text-align:right;font-weight:600;color:#111827;">${fmtDecimal(lt)}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice ${invoiceNumber}</title></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:680px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 8px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:#ffffff;padding:24px 32px;text-align:center;border-bottom:2px solid #e5e7eb;">
      ${logoBase64
        ? `<img src="data:image/png;base64,${logoBase64}" style="max-height:80px;max-width:280px;display:block;margin:0 auto;" alt="Apollonia Construction LLC" />`
        : `<div style="font-size:22px;font-weight:800;color:#111827;">Apollonia Construction LLC</div><div style="font-size:13px;color:#6b7280;margin-top:4px;">Omaha, Nebraska</div>`
      }
    </div>

    <!-- Body -->
    <div style="padding:32px;">

      <!-- Bill-to + Invoice meta -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:28px;">
        <tr>
          <td style="vertical-align:top;width:55%;">
            <div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;">Bill To</div>
            <div style="font-size:15px;font-weight:700;color:#111827;">${job.billToName || ''}</div>
            ${job.billToAddress ? `<div style="font-size:13px;color:#6b7280;margin-top:4px;">${job.billToAddress}</div>` : ''}
            ${job.email ? `<div style="font-size:13px;color:#6b7280;margin-top:2px;">${job.email}</div>` : ''}
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
                <td style="font-size:12px;font-weight:600;color:#dc2626;padding:3px 0;">${formatDate(dueDate)}</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

      <!-- Project -->
      <div style="background:#f0fdf4;border-radius:8px;padding:14px 16px;margin-bottom:24px;border-left:4px solid #16a34a;">
        <div style="font-size:10px;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px;">Project</div>
        <div style="font-size:15px;font-weight:700;color:#111827;">${job.projectName || ''}</div>
        ${job.jobLocationAddress ? `<div style="font-size:13px;color:#6b7280;margin-top:2px;">${job.jobLocationAddress}</div>` : ''}
        ${job.targetDate ? `<div style="font-size:12px;color:#6b7280;margin-top:4px;">Target Date: ${formatDate(job.targetDate)}</div>` : ''}
      </div>

      <!-- Line items -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e5e7eb;">Description</th>
            <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e5e7eb;width:50px;">Qty</th>
            <th style="padding:10px 12px;text-align:right;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e5e7eb;width:80px;">Unit Price</th>
            <th style="padding:10px 12px;text-align:right;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e5e7eb;width:80px;">Total</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>

      <!-- Totals -->
      <div style="margin-left:auto;max-width:240px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="padding:6px 0;font-size:13px;color:#6b7280;">Subtotal</td>
            <td style="padding:6px 0;font-size:13px;color:#111827;text-align:right;">${fmtDecimal(subtotal)}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;font-size:13px;color:#6b7280;">Tax (7%)</td>
            <td style="padding:6px 0;font-size:13px;color:#111827;text-align:right;">${fmtDecimal(tax)}</td>
          </tr>
          <tr>
            <td colspan="2"><hr style="border:none;border-top:2px solid #e5e7eb;margin:8px 0;"></td>
          </tr>
          <tr>
            <td style="padding:4px 0;font-size:16px;font-weight:800;color:#111827;">Total Due</td>
            <td style="padding:4px 0;font-size:18px;font-weight:800;color:#16a34a;text-align:right;">${fmtDecimal(total)}</td>
          </tr>
        </table>
      </div>

    </div>

    <!-- Footer -->
    <div style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 32px;text-align:center;">
      <div style="font-size:12px;color:#9ca3af;">Thank you for your business. Please remit payment by ${formatDate(dueDate)}.</div>
      <div style="font-size:12px;color:#9ca3af;margin-top:4px;">Questions? Contact us at ${FROM_EMAIL}</div>
      ${photoNote}
    </div>

  </div>
</body>
</html>`;
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Generates a PDF from the invoice HTML and sends it via SendGrid.
 * Returns { ok: true } on success or throws an Error with a message.
 */
export async function sendInvoiceEmail(job, invoiceNumber, invDate, dueDate, lineItems) {
  const toEmail = job.email;
  if (!toEmail) throw new Error('No email address on file for this customer.');

  // ── Load logo as base64 ──
  let logoBase64 = '';
  try {
    const [logoAsset] = await Asset.loadAsync(require('../../assets/Apollonia_new.png'));
    if (logoAsset.localUri) {
      logoBase64 = await FileSystem.readAsStringAsync(logoAsset.localUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
    }
  } catch { /* logo is optional — fall back to text header */ }

  // ── Generate PDF ──
  let pdfBase64 = null;
  let pdfUri    = null;
  try {
    const html = buildInvoiceHTML(job, invoiceNumber, invDate, dueDate, lineItems, '', logoBase64);
    const { uri } = await Print.printToFileAsync({ html, base64: false });
    pdfUri    = uri;
    pdfBase64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  } catch (pdfErr) {
    console.warn('[Invoice] PDF generation failed:', pdfErr.message);
  } finally {
    if (pdfUri) FileSystem.deleteAsync(pdfUri, { idempotent: true }).catch(() => {});
  }

  // ── Compress and collect job photos ──
  const MAX_PHOTO_BYTES = 2.5 * 1024 * 1024; // 2.5 MB budget for photos
  const photoAttachments = [];
  let photoTotalBytes = 0;
  let skippedCount = 0;

  if (job.photos && job.photos.length > 0) {
    for (const photoUrl of job.photos) {
      if (!photoUrl) continue;
      let tmpUri = null;
      let resizedUri = null;
      try {
        const filename = photoUrl.split('/').pop().split('?')[0];
        tmpUri = FileSystem.cacheDirectory + 'invoice_photo_' + filename;
        const downloadResult = await FileSystem.downloadAsync(photoUrl, tmpUri);
        if (downloadResult.status !== 200) { skippedCount++; continue; }

        const result = await ImageManipulator.manipulateAsync(
          tmpUri,
          [{ resize: { width: 800 } }],
          { compress: 0.5, format: ImageManipulator.SaveFormat.JPEG },
        );
        resizedUri = result.uri;

        const b64 = await FileSystem.readAsStringAsync(resizedUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const byteEst = Math.ceil((b64.length * 3) / 4);

        if (photoTotalBytes + byteEst > MAX_PHOTO_BYTES) {
          skippedCount++;
          continue;
        }

        photoTotalBytes += byteEst;
        photoAttachments.push({
          content:     b64,
          type:        'image/jpeg',
          filename:    `photo-${photoAttachments.length + 1}.jpg`,
          disposition: 'attachment',
        });
      } catch {
        skippedCount++;
      } finally {
        if (tmpUri) FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
        if (resizedUri && resizedUri !== tmpUri) FileSystem.deleteAsync(resizedUri, { idempotent: true }).catch(() => {});
      }
    }
  }

  // ── Build email HTML (with photo note) ──
  const totalPhotos = (job.photos || []).length;
  const attachedPhotos = photoAttachments.length;
  let photoNote = '';
  if (totalPhotos > 0) {
    photoNote = attachedPhotos === totalPhotos
      ? `<p style="font-size:13px;color:#6b7280;margin-top:16px;">${attachedPhotos} job site photo${attachedPhotos !== 1 ? 's' : ''} attached.</p>`
      : `<p style="font-size:13px;color:#6b7280;margin-top:16px;">${attachedPhotos} of ${totalPhotos} job site photos attached (remaining photos exceed email size limit).</p>`;
  }

  const html    = buildInvoiceHTML(job, invoiceNumber, invDate, dueDate, lineItems, photoNote, logoBase64);
  const subject = `Invoice #${invoiceNumber} from Apollonia Construction LLC`;

  // ── Plain-text version ──
  const visibleItems = lineItems.filter((i) => (Number(i.qty) || 0) > 0);
  const { subtotal, tax, total } = calcTotals(lineItems);
  const itemLines = visibleItems.map(
    (i) => `  ${i.description.padEnd(40)} ${String(i.qty).padStart(4)} x ${fmtDecimal(i.unitPrice).padStart(9)} = ${fmtDecimal((Number(i.qty) || 0) * (Number(i.unitPrice) || 0))}`,
  ).join('\n');

  const plainText = [
    `INVOICE #${invoiceNumber}`,
    `Apollonia Construction LLC — Omaha, Nebraska`,
    '',
    `Invoice Date : ${formatDate(invDate)}`,
    `Due Date     : ${formatDate(dueDate)}`,
    '',
    `Bill To`,
    `-------`,
    job.billToName || '',
    job.billToAddress || '',
    job.email || '',
    '',
    `Project`,
    `-------`,
    job.projectName || '',
    job.jobLocationAddress || '',
    job.targetDate ? `Target Date: ${formatDate(job.targetDate)}` : '',
    '',
    `Line Items`,
    `----------`,
    itemLines,
    '',
    `Subtotal : ${fmtDecimal(subtotal)}`,
    `Tax (7%) : ${fmtDecimal(tax)}`,
    `─────────────────────`,
    `Total Due: ${fmtDecimal(total)}`,
    '',
    `Please remit payment by ${formatDate(dueDate)}.`,
    `Questions? Reply to this email or contact ${REPLY_TO}.`,
    '',
    `This invoice was sent by Apollonia Construction LLC.`,
    `To stop receiving invoices, reply with "unsubscribe".`,
  ].filter((l) => l !== undefined).join('\n');

  // ── Build SendGrid payload ──
  const attachments = [];
  if (pdfBase64) {
    attachments.push({
      content:     pdfBase64,
      type:        'application/pdf',
      filename:    `Invoice-${invoiceNumber}.pdf`,
      disposition: 'attachment',
    });
  }
  attachments.push(...photoAttachments);

  const payload = {
    personalizations: [{
      to: [{ email: toEmail }],
      cc: CC_EMAILS.map((email) => ({ email })),
    }],
    from:     { email: FROM_EMAIL, name: FROM_NAME },
    reply_to: { email: REPLY_TO },
    subject,
    content: [
      { type: 'text/plain', value: plainText },
      { type: 'text/html',  value: html },
    ],
    headers: {
      'List-Unsubscribe': `<mailto:${REPLY_TO}?subject=unsubscribe>`,
      'X-Mailer': 'Apollonia Construction App',
    },
    ...(attachments.length > 0 ? { attachments } : {}),
  };

  // ── Send ──
  const response = await fetch(SENDGRID_URL, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (response.status === 202) return { ok: true };

  let errMsg = `SendGrid error ${response.status}`;
  try {
    const body = await response.json();
    const first = body?.errors?.[0]?.message;
    if (first) errMsg = first;
  } catch { /* ignore */ }

  throw new Error(errMsg);
}
