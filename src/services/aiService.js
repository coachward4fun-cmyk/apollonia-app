import { getJobs, getExpenses, saveJob, saveExpense } from './db';
import { ANTHROPIC_API_KEY, CLAUDE_MODEL } from '../config/anthropic';
import { logActivity } from './activityLog';

const SYSTEM_PROMPT = `You are the Apollonia Assistant, an AI helper for Apollonia Construction LLC.
You help manage business operations: jobs, crews, invoices, and expenses.

CRITICAL: Always respond with raw JSON only. No markdown, no code blocks, no prose outside JSON.

Response format for answers/questions:
{"message":"Your concise response (1-3 sentences, suitable for speaking aloud)","autoSpeak":true,"pendingAction":null}

Response format when proposing a write action:
{"message":"I'll [what you'll do]. Say YES to confirm or NO to cancel.","autoSpeak":true,"pendingAction":{"type":"ACTION_TYPE","description":"Human-readable summary","data":{...}}}

Action types and their data fields:
- CREATE_JOB: { title, customerName, address, targetDate (YYYY-MM-DD), status }
- UPDATE_JOB_STATUS: { jobId, newStatus }
- MARK_CREW_PAID: { jobId }
- CREATE_EXPENSE: { description, amount, date (YYYY-MM-DD), category }
- START_VOICE_FLOW: { flowType: "new_job" | "new_customer" | "edit_job", jobId: null }

Rules:
- Keep "message" brief — it will be spoken aloud
- "autoSpeak" should be false ONLY when pendingAction is set (user needs to read before confirming)
- NEVER execute a write action without first getting user confirmation — always set pendingAction, never execute directly
- When user asks to "create a job", "new job", "add a job" → use START_VOICE_FLOW with flowType "new_job"; message should say "I'll guide you through creating a new job step by step."
- When user asks to "create a customer", "new customer", "add a customer" → use START_VOICE_FLOW with flowType "new_customer"
- When user asks to "edit a job" or "change a job" without specifying fields → use START_VOICE_FLOW with flowType "edit_job"
- If the user is on the Admin screen (isAdminScreen: true in context), set pendingAction to null and say "Sorry, I am restricted from making changes on the Admin screen."
- Respond in English only
- Reference specific job titles, customer names, and crew names from the provided data
- For financial figures, use exact numbers from the data`;

// ── Voice flow definitions ────────────────────────────────────────────────────
// Each step has a spoken question and the fields it collects.

export const VOICE_FLOWS = {
  new_job: {
    label: 'Creating New Job',
    steps: [
      { question: "What is the customer name and job type?", fields: ['billToName', 'jobType'] },
      { question: "What is the job location address and target date?", fields: ['jobLocationAddress', 'targetDate'] },
      { question: "Which crew should be assigned, and who is the salesperson? Say 'skip' to leave these blank.", fields: ['crewName', 'salesperson'] },
    ],
  },
  new_customer: {
    label: 'Creating New Customer',
    steps: [
      { question: "What is the customer name and email address?", fields: ['name', 'email'] },
      { question: "What is the billing address and salesperson? Say 'skip' to leave blank.", fields: ['address', 'salesperson'] },
    ],
  },
  edit_job: {
    label: 'Editing Job',
    steps: [
      { question: "What would you like to change on this job? For example: 'change the date to May 20th' or 'assign Crew 1'.", fields: ['targetDate', 'crewName', 'status', 'salesperson', 'jobLocationAddress', 'notes'] },
    ],
  },
};

// ── Field extraction for voice flows ─────────────────────────────────────────
// Uses Claude to parse natural language into structured field values.

export async function extractFlowFields({ userText, fieldsToExtract, availableCrews = [], availableJobTypes = [], today }) {
  const crewList = availableCrews.map((c) => c.name).join(', ') || 'none';
  const typeList = availableJobTypes.join(', ') || 'Roofing, Gutters, Siding, Concrete, Painting';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':          ANTHROPIC_API_KEY,
      'anthropic-version':  '2023-06-01',
      'content-type':       'application/json',
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 300,
      system: `Extract structured data from user speech. Return ONLY valid JSON, no markdown.
Today: ${today}
Available job types: ${typeList}
Available crews: ${crewList}

Field definitions:
- billToName: customer or client full name
- jobType: type of job — match to available types (exact name)
- jobLocationAddress: full job site address (street, city, state)
- targetDate: target job date in YYYY-MM-DD format (interpret relative dates like "May 20th" using today's date)
- crewName: crew name — match to available crews exactly
- salesperson: salesperson full name
- name: person or company name
- email: email address
- address: billing or mailing address
- status: one of "Not Scheduled", "Scheduled", "In Progress", "Invoice Ready", "Invoice Sent", "Invoice Paid", "Cancelled"
- notes: free-text notes
- changes: summary of all changes mentioned (free text)

Extract ONLY these fields: ${fieldsToExtract.join(', ')}
If the user says "skip", "none", or a field is not mentioned: set to null.
Include a "summary" key with a brief human-readable summary of what was captured (1-2 sentences).

Example output: {"billToName":"John Smith","jobType":"Roofing","summary":"Customer John Smith, job type Roofing"}`,
      messages: [{ role: 'user', content: userText }],
    }),
  });

  const data    = await response.json();
  const rawText = data.content?.[0]?.text?.trim() || '{}';
  try {
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { summary: userText };
  }
}

// jobs and crews flow in from AppDataContext (already-live subscriptions in the
// caller). Only expenses are fetched here, since they aren't in context yet.
export async function sendAIMessage(conversationHistory, isAdminScreen, userName, { jobs = [], crews = [] } = {}) {
  const allJobs    = jobs;
  const allCrews   = crews;
  const allExpenses = await getExpenses();

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyStr = thirtyDaysAgo.toISOString().slice(0, 10);
  const todayStr  = new Date().toISOString().slice(0, 10);
  const ytdStr    = `${new Date().getFullYear()}-01-01`;

  // Financial summary totals (YTD)
  const revenueYTD = allJobs
    .filter((j) => (j.status || '').toLowerCase() === 'invoice paid' && (j.invoiceDate || j.targetDate || '') >= ytdStr)
    .reduce((s, j) => s + (Number(j.invoiceTotal) || 0), 0);
  const expensesYTD = allExpenses
    .filter((e) => (e.date || '') >= ytdStr)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);

  // Jobs summary — status counts + up to 20 active/upcoming jobs for action targeting
  const oneWeekAheadStr = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().slice(0, 10); })();
  const statusCounts = {};
  for (const j of allJobs) {
    const s = (j.status || 'Not Scheduled').toLowerCase();
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }
  const activeStatuses = new Set(['scheduled', 'in progress', 'invoice ready', 'invoice sent']);
  const upcomingJobs = [...allJobs]
    .filter((j) => {
      const s = (j.status || '').toLowerCase();
      const d = j.targetDate || '';
      return activeStatuses.has(s) || (d >= todayStr && d <= oneWeekAheadStr);
    })
    .sort((a, b) => (a.targetDate || '').localeCompare(b.targetDate || ''))
    .slice(0, 20)
    .map((j) => ({
      id: j.id,
      name: j.projectName,
      customer: j.billToName,
      status: j.status,
      date: j.targetDate,
      crew: allCrews.find((c) => c.id === j.crewId)?.name || null,
      total: j.invoiceTotal,
      crewPaidAt: j.crewPaidAt || null,
    }));

  // Expense summary — totals by category + 5 most recent
  const expByCategory = {};
  const recentExpenses = allExpenses
    .filter((e) => (e.date || '') >= thirtyStr)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  for (const e of recentExpenses) {
    const cat = e.category || 'Other';
    expByCategory[cat] = (expByCategory[cat] || 0) + (Number(e.amount) || 0);
  }

  const contextCrews = allCrews.map((c) => ({ id: c.id, name: c.name, lead: c.leadName }));

  const contextBlock = JSON.stringify({
    today: todayStr,
    currentUser: userName,
    isAdminScreen,
    financials: { revenueYTD, expensesYTD, netYTD: revenueYTD - expensesYTD },
    jobs: { total: allJobs.length, byStatus: statusCounts, upcoming: upcomingJobs },
    crews: contextCrews,
    expenses: {
      totalLast30Days: recentExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0),
      byCategory: expByCategory,
      recent: recentExpenses.slice(0, 5).map((e) => ({ id: e.id, description: e.description, amount: e.amount, date: e.date })),
    },
  });

  const system = `${SYSTEM_PROMPT}\n\nCurrent app data:\n${contextBlock}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      system,
      messages: conversationHistory.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const rawText = data.content?.[0]?.text?.trim() || '{}';

  let parsed;
  try {
    // Strip accidental markdown code fences
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = { message: rawText, autoSpeak: true, pendingAction: null };
  }

  return {
    message:       parsed.message  || 'Sorry, I had trouble understanding that.',
    autoSpeak:     parsed.autoSpeak !== false,
    pendingAction: parsed.pendingAction || null,
  };
}

export async function executeAction(action) {
  switch (action.type) {
    case 'CREATE_JOB': {
      // Business rule: a job cannot have status "Scheduled" without a target date.
      if (action.data.status === 'Scheduled' && !action.data.targetDate) {
        throw new Error('A target date is required for Scheduled status. Provide a target date or use a different status.');
      }
      const id  = `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const job = { id, ...action.data, createdAt: new Date().toISOString() };
      await saveJob(job);
      logActivity('ai_create_job', `AI created job: ${action.data.title || action.data.customerName || id}`);
      return `Job created successfully.`;
    }
    case 'UPDATE_JOB_STATUS': {
      // Business rule: setting status to "Scheduled" requires the job to have a target date.
      if (action.data.newStatus === 'Scheduled') {
        const allJobs = await getJobs();
        const existing = allJobs.find((j) => j.id === action.data.jobId);
        if (!existing?.targetDate) {
          throw new Error('Cannot set status to Scheduled — this job has no target date. Set a target date first.');
        }
      }
      await saveJob({ id: action.data.jobId, status: action.data.newStatus });
      logActivity('ai_update_job', `AI updated job ${action.data.jobId} status → ${action.data.newStatus}`);
      return `Job status updated to ${action.data.newStatus}.`;
    }
    case 'MARK_CREW_PAID': {
      const today = new Date().toISOString().slice(0, 10);
      await saveJob({ id: action.data.jobId, crewPaidAt: today });
      logActivity('ai_mark_paid', `AI marked crew paid for job ${action.data.jobId}`);
      return 'Crew marked as paid.';
    }
    case 'CREATE_EXPENSE': {
      const id      = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const expense = { id, ...action.data };
      await saveExpense(expense);
      logActivity('ai_create_expense', `AI created expense: ${action.data.description} $${action.data.amount}`);
      return `Expense created: ${action.data.description}.`;
    }
    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}
