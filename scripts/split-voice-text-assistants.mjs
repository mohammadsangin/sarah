#!/usr/bin/env node
// Split the single "Sarah" Vapi assistant into a voice assistant and a text
// assistant, each carrying only its own escalation rule — so there is no
// voice/text contradiction for the model to resolve.
//
// WHAT IT DOES
//   • Keeps the ORIGINAL assistant as the VOICE assistant (it's attached to the
//     phone number — this script never touches phone numbers or its tools, so
//     transfer_to_human keeps working). It only edits the voice system prompt
//     to remove the text-chat escalation sections.
//   • Creates a COPY named "Sarah — Text" whose system prompt has the on-a-call
//     sections and the Pronunciation Rules section removed, and whose tools no
//     longer include transfer_to_human (so it can't be called in text).
//   • Everything else (identity, Critical Price Rule, Critical Facts, general
//     rules, lookup_products) is copied byte-for-byte, so both give identical
//     answers on facts.
//
// SECTION SELECTION (by markdown ## / # headers, dash- and case-insensitive):
//   voice → drop every heading containing "in text chat"
//           (i.e. "Request to Speak to a Human — IN TEXT CHAT" and "In Text Chat")
//   text  → drop every heading containing "on a call" (both — ON A CALL sections)
//           and the "Pronunciation Rules" heading.
//
// SAFETY
//   • DRY RUN by default: prints exactly which sections would be removed from
//     each assistant, the resulting tool list for the text copy, and the new
//     name — and writes NOTHING. Add --apply to perform the changes.
//   • If a named section isn't found, it warns loudly (the header text in your
//     prompt differs from what's expected) and — unless --force — refuses to
//     apply, so you don't silently get a half-done split.
//   • Run --selftest to exercise the prompt-surgery logic offline (no network,
//     no key needed).
//
// USAGE
//   node scripts/split-voice-text-assistants.mjs --selftest
//
//   export VAPI_PRIVATE_KEY="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
//   export ASSISTANT_ID="f67cfb35-5f40-430d-b70f-718940af7a43"   # optional; this is the default
//   node scripts/split-voice-text-assistants.mjs                 # dry run (preview)
//   node scripts/split-voice-text-assistants.mjs --apply         # do it

const API = 'https://api.vapi.ai';
const DEFAULT_ASSISTANT_ID = 'f67cfb35-5f40-430d-b70f-718940af7a43';
const TEXT_NAME = process.env.TEXT_ASSISTANT_NAME || 'Sarah — Text';

// ── pure helpers (unit-tested by --selftest) ───────────────────────────────

// Normalize a heading for matching: lowercase, unify dash characters, collapse
// whitespace. So "— ON A CALL", "- on a call", "–  On A Call" all compare equal.
function normHeading(text) {
  return String(text)
    .replace(/[‒–—―−]/g, '-') // various dashes → hyphen
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const HEADING_RE = /^(#{1,2})\s+(.*\S)\s*$/; // level-1 or level-2 markdown heading

// Parse a prompt into ordered sections. The text before the first heading is a
// headerless "preamble" section that is never dropped.
function parseSections(content) {
  const lines = String(content).split('\n');
  const sections = [];
  let cur = { heading: null, lines: [] };
  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      sections.push(cur);
      cur = { heading: m[2], lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  sections.push(cur);
  // Drop a possible empty leading preamble with no content.
  return sections.filter((s, i) => !(i === 0 && s.heading === null && s.lines.join('').trim() === ''));
}

// Remove sections whose heading matches predicate(normHeading). Returns
// { result, removed: [headings], kept: [headings] }.
function removeSections(content, predicate) {
  const sections = parseSections(content);
  const removed = [];
  const kept = [];
  const out = [];
  for (const s of sections) {
    if (s.heading !== null && predicate(normHeading(s.heading))) {
      removed.push(s.heading);
      continue;
    }
    if (s.heading !== null) kept.push(s.heading);
    out.push(s.lines.join('\n'));
  }
  // Rejoin, then collapse any run of 3+ blank lines left by a removal to one
  // blank line, and trim trailing whitespace.
  let text = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n');
  return { result: text.replace(/\s+$/,'') + '\n', removed, kept };
}

const isTextChat = (h) => h.includes('in text chat');
const isOnACall = (h) => h.includes('on a call');
const isPronunciation = (h) => h.includes('pronunciation');

function buildVoicePrompt(content) {
  return removeSections(content, isTextChat);
}
function buildTextPrompt(content) {
  return removeSections(content, (h) => isOnACall(h) || isPronunciation(h));
}

// Identify a tool object as the human-transfer tool (built-in transferCall, or
// a function tool named transfer_to_human).
function isTransferTool(tool) {
  if (!tool || typeof tool !== 'object') return false;
  const type = String(tool.type || '').toLowerCase();
  if (type === 'transfercall') return true;
  const name = String((tool.function && tool.function.name) || tool.name || '').toLowerCase();
  return name === 'transfer_to_human';
}

// Apply the section edit to whichever system message(s) exist in a model.
function editSystemMessages(model, builder) {
  const messages = Array.isArray(model.messages) ? model.messages.map((m) => ({ ...m })) : [];
  const sysIdx = messages.map((m, i) => (m.role === 'system' ? i : -1)).filter((i) => i >= 0);
  const allRemoved = [];
  if (sysIdx.length === 0) {
    return { messages, removed: [], warning: 'no system message found' };
  }
  for (const i of sysIdx) {
    const { result, removed } = builder(messages[i].content || '');
    messages[i] = { ...messages[i], content: result };
    allRemoved.push(...removed);
  }
  return { messages, removed: allRemoved, warning: null };
}

// ── network ────────────────────────────────────────────────────────────────

function requireKey() {
  const key = process.env.VAPI_PRIVATE_KEY;
  if (!key) {
    console.error('ERROR: set VAPI_PRIVATE_KEY');
    process.exit(1);
  }
  return key;
}

async function api(path, { method = 'GET', key, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 800)}`);
  }
  return json;
}

// Strip server-managed / read-only fields before re-creating an assistant.
const READONLY_KEYS = ['id', 'orgId', 'createdAt', 'updatedAt', 'isServerUrlSecretSet'];
function stripReadonly(obj) {
  const copy = JSON.parse(JSON.stringify(obj));
  for (const k of READONLY_KEYS) delete copy[k];
  return copy;
}

// ── selftest ────────────────────────────────────────────────────────────────

function selftest() {
  const SAMPLE = [
    '# Identity',
    'You are Sarah, assistant for Kymra Lighting.',
    '',
    '## Critical Price Rule',
    'Always call lookup_products for prices.',
    '',
    '## Critical Facts',
    'Free UK delivery over £500. Returns within 30 days.',
    '',
    '## Request to Speak to a Human — ON A CALL',
    'Call transfer_to_human to connect them.',
    '',
    '## Request to Speak to a Human — IN TEXT CHAT',
    'Give the email sales@kymralighting.co.uk and phone +44 7863 771703.',
    '',
    '## Escalation — ON A CALL',
    'Warm-transfer using transfer_to_human.',
    '',
    '## In Text Chat',
    'Never say you can transfer to a human; share contact details instead.',
    '',
    '## Pronunciation Rules',
    'Say "Kymra" as KIM-ra.',
    '',
    '## General Rules',
    'Be concise and friendly.',
    '',
  ].join('\n');

  let failures = 0;
  const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };

  const voice = buildVoicePrompt(SAMPLE);
  const text = buildTextPrompt(SAMPLE);

  console.log('--- VOICE removed:', JSON.stringify(voice.removed));
  check('voice removes 2 sections', voice.removed.length === 2);
  check('voice drops IN TEXT CHAT escalation body', !/give the email/i.test(voice.result));
  check('voice no "In Text Chat" body', !/share contact details instead/i.test(voice.result));
  check('voice KEEPS both ON A CALL sections', /— ON A CALL/g.test(voice.result) && (voice.result.match(/on a call/gi) || []).length === 2);
  check('voice keeps transfer_to_human mention', /transfer_to_human/.test(voice.result));
  check('voice keeps Pronunciation', /Pronunciation Rules/.test(voice.result));
  check('voice keeps Identity/Price/Facts/General', /# Identity/.test(voice.result) && /Critical Price Rule/.test(voice.result) && /Critical Facts/.test(voice.result) && /General Rules/.test(voice.result));

  console.log('--- TEXT removed:', JSON.stringify(text.removed));
  check('text removes 3 sections', text.removed.length === 3);
  check('text drops BOTH ON A CALL sections', !/on a call/i.test(text.result));
  check('text drops Pronunciation', !/Pronunciation/i.test(text.result) && !/KIM-ra/.test(text.result));
  check('text KEEPS IN TEXT CHAT sections', /Request to Speak to a Human — IN TEXT CHAT/.test(text.result) && /In Text Chat/.test(text.result));
  check('text keeps contact-details escalation', /share contact details instead/i.test(text.result));
  check('text keeps Identity/Price/Facts/General', /# Identity/.test(text.result) && /Critical Price Rule/.test(text.result) && /Critical Facts/.test(text.result) && /General Rules/.test(text.result));

  // tool filtering
  const tools = [
    { type: 'function', function: { name: 'lookup_products' } },
    { type: 'transferCall', destinations: [] },
    { type: 'function', function: { name: 'transfer_to_human' } },
    { type: 'function', function: { name: 'lookup_policy' } },
  ];
  const kept = tools.filter((t) => !isTransferTool(t));
  check('tool filter drops transferCall', !kept.some((t) => t.type === 'transferCall'));
  check('tool filter drops transfer_to_human fn', !kept.some((t) => (t.function && t.function.name) === 'transfer_to_human'));
  check('tool filter keeps lookup_products & lookup_policy', kept.length === 2);

  console.log(`\n${failures === 0 ? 'ALL SELFTESTS PASSED' : failures + ' SELFTEST(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();

  const APPLY = argv.includes('--apply');
  const FORCE = argv.includes('--force');
  const key = requireKey();
  const assistantId = process.env.ASSISTANT_ID || DEFAULT_ASSISTANT_ID;

  console.log(`Reading assistant ${assistantId} ...`);
  const original = await api(`/assistant/${assistantId}`, { key });
  const model = original.model || {};
  console.log(`  name: ${original.name || '(unnamed)'}   provider: ${model.provider}   model: ${model.model}`);

  // ---- compute the two prompts ----
  const voiceEdit = editSystemMessages(model, buildVoicePrompt);
  const textEdit = editSystemMessages(model, buildTextPrompt);

  console.log('\n=== VOICE assistant (edit original, keep phone + transfer) ===');
  console.log('  sections removed:', voiceEdit.removed.length ? voiceEdit.removed.map((h) => `“${h}”`).join(', ') : '(none)');
  console.log('\n=== TEXT assistant (new copy: "' + TEXT_NAME + '") ===');
  console.log('  sections removed:', textEdit.removed.length ? textEdit.removed.map((h) => `“${h}”`).join(', ') : '(none)');

  // ---- resolve + filter tools for the text copy ----
  const inlineTools = Array.isArray(model.tools) ? model.tools : [];
  const droppedInline = inlineTools.filter(isTransferTool);
  const keptInline = inlineTools.filter((t) => !isTransferTool(t));

  const toolIds = Array.isArray(model.toolIds) ? model.toolIds : [];
  const droppedToolIds = [];
  const keptToolIds = [];
  for (const tid of toolIds) {
    let tool;
    try { tool = await api(`/tool/${tid}`, { key }); } catch { tool = null; }
    const label = tool ? ((tool.function && tool.function.name) || tool.name || tool.type) : tid;
    if (tool && isTransferTool(tool)) droppedToolIds.push(`${label} [${tid}]`);
    else keptToolIds.push(tid);
  }
  console.log('  tools dropped:',
    [...droppedInline.map((t) => (t.function && t.function.name) || t.type), ...droppedToolIds].join(', ') || '(none — no transfer tool found)');
  console.log('  toolIds kept:', keptToolIds.length ? keptToolIds.join(', ') : '(none)');

  // ---- sanity warnings ----
  const problems = [];
  if (voiceEdit.removed.length === 0) problems.push('voice: no "in text chat" section found to remove');
  if (!textEdit.removed.some((h) => isOnACall(normHeading(h)))) problems.push('text: no "on a call" section found to remove');
  if (!textEdit.removed.some((h) => isPronunciation(normHeading(h)))) problems.push('text: no "Pronunciation Rules" section found to remove');
  if (droppedInline.length === 0 && droppedToolIds.length === 0) problems.push('text: no transfer_to_human / transferCall tool found to drop');
  if (voiceEdit.warning) problems.push('voice: ' + voiceEdit.warning);
  if (problems.length) {
    console.log('\n⚠  WARNINGS:');
    for (const p of problems) console.log('   - ' + p);
    console.log('   (Header text in your prompt may differ from what was expected — check the previews.)');
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to make the changes.');
    console.log('Tip: pipe to see full prompts:  node scripts/split-voice-text-assistants.mjs --print-prompts');
    if (argv.includes('--print-prompts')) {
      console.log('\n----- VOICE PROMPT -----\n' + (voiceEdit.messages.find((m) => m.role === 'system')?.content || ''));
      console.log('\n----- TEXT PROMPT -----\n' + (textEdit.messages.find((m) => m.role === 'system')?.content || ''));
    }
    return;
  }

  if (problems.length && !FORCE) {
    console.error('\nRefusing to --apply with warnings above. Re-check the header text, or pass --force to proceed anyway.');
    process.exit(1);
  }

  // ---- 1) create the TEXT copy ----
  console.log('\nCreating text assistant ...');
  const textBody = stripReadonly(original);
  textBody.name = TEXT_NAME;
  textBody.model = { ...model, messages: textEdit.messages, tools: keptInline, toolIds: keptToolIds };
  const created = await api('/assistant', { method: 'POST', key, body: textBody });
  console.log(`  created text assistant: ${created.id}`);

  // ---- 2) edit the VOICE (original) prompt only; leave its tools/phone alone ----
  console.log('Updating voice (original) system prompt ...');
  await api(`/assistant/${assistantId}`, {
    method: 'PATCH',
    key,
    body: { model: { ...model, messages: voiceEdit.messages } },
  });
  console.log('  voice assistant updated (tools and phone number untouched).');

  console.log('\n=====================================================');
  console.log(' DONE');
  console.log('   Voice assistant (phone): ' + assistantId);
  console.log('   TEXT assistant (widget): ' + created.id + '   ← point the chat widget here');
  console.log('=====================================================');
}

main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
