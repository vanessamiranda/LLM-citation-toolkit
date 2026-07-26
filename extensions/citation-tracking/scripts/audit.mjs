/**
 * GEO collector v2 — search grounding on all four engines.
 *
 * Runs in GitHub Actions only, never in the browser, because it holds keys.
 * Each engine's `grounded` flag in config/geo.config.json decides whether a
 * live web-search tool is attached. Grounded and ungrounded answers measure
 * different things, so the flag is recorded per record and surfaced in the
 * dashboard footer.
 *
 *   node scripts/audit.mjs
 *
 * Engines without a secret are skipped and recorded as skipped. Nothing is
 * ever invented to fill a gap.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { computeScores, extractCitations } from './score.mjs';

const ROOT = new URL('..', import.meta.url);
const cfg = JSON.parse(await readFile(new URL('config/geo.config.json', ROOT), 'utf8'));

const PATTERNS = Object.fromEntries(cfg.brands.map(b => [b.id, b.pattern]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ANSWER_CAP = 700;
const uniq = a => [...new Set(a.filter(Boolean))];

/* ------------------------------------------------------------------ adapters
   Every adapter returns { text, sources }.
   `sources` is populated only when the engine actually searched.
--------------------------------------------------------------------------- */

/** Gemini — google_search grounding tool. Free tier. */
async function gemini(prompt, e, key) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: `${prompt}\n\n${cfg.instruction}` }] }]
  };
  if (e.grounded) body.tools = [{ google_search: {} }];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${e.model}:generateContent`,
    { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const cand = (await res.json()).candidates?.[0];
  const text = (cand?.content?.parts ?? []).map(p => p.text ?? '').join('');
  const sources = uniq((cand?.groundingMetadata?.groundingChunks ?? []).map(c => c.web?.uri));
  return { text, sources };
}

/** Claude — server-side web_search tool. Billed per search on top of tokens. */
async function claude(prompt, e, key) {
  const body = {
    model: e.model,
    max_tokens: 1200,
    messages: [{ role: 'user', content: `${prompt}\n\n${cfg.instruction}` }]
  };
  if (e.grounded) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: e.maxSearches ?? 3 }];
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const blocks = (await res.json()).content ?? [];
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
  // Search results arrive as web_search_tool_result blocks; citations may also
  // be attached to individual text blocks.
  const sources = uniq([
    ...blocks.filter(b => b.type === 'web_search_tool_result')
             .flatMap(b => (Array.isArray(b.content) ? b.content : []).map(r => r.url)),
    ...blocks.flatMap(b => (b.citations ?? []).map(c => c.url))
  ]);
  return { text, sources };
}

/** ChatGPT — Responses API with the web_search tool.
 *  Chat Completions does not accept this tool on current models, so
 *  /v1/responses is required rather than merely preferred. */
async function chatgpt(prompt, e, key) {
  const body = {
    model: e.model,
    input: `${prompt}\n\n${cfg.instruction}`,
    max_output_tokens: 1200
  };
  if (e.grounded) body.tools = [{ type: 'web_search' }];

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const j = await res.json();
  const messages = (j.output ?? []).filter(o => o.type === 'message');
  const text = j.output_text
    ?? messages.flatMap(m => (m.content ?? []).map(c => c.text ?? '')).join('\n');
  const sources = uniq(messages.flatMap(m =>
    (m.content ?? []).flatMap(c => (c.annotations ?? [])
      .filter(a => a.type === 'url_citation').map(a => a.url))));
  return { text, sources };
}

/** Perplexity — Sonar always searches; the grounded flag is informational. */
async function perplexity(prompt, e, key) {
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: e.model,
      max_tokens: 900,
      messages: [{ role: 'user', content: `${prompt}\n\n${cfg.instruction}` }]
    })
  });
  if (!res.ok) throw new Error(`Perplexity ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const j = await res.json();
  return {
    text: j.choices?.[0]?.message?.content ?? '',
    sources: uniq(j.citations ?? (j.search_results ?? []).map(s => s.url))
  };
}

const ADAPTERS = { gemini, claude, chatgpt, perplexity };

/* ------------------------------------------------------------------- collect */

const records = [];
const engineStatus = [];

for (const engine of cfg.engines) {
  const key = process.env[engine.secret];
  const adapter = ADAPTERS[engine.id];

  if (!key) {
    engineStatus.push({ ...engine, ran: false, reason: `no ${engine.secret} secret set` });
    console.log(`skip   ${engine.name.padEnd(11)} no ${engine.secret}`);
    continue;
  }
  if (!adapter) {
    engineStatus.push({ ...engine, ran: false, reason: 'no adapter implemented' });
    continue;
  }

  console.log(`\n--- ${engine.name} (${engine.model}) ${engine.grounded ? 'grounded' : 'ungrounded'} ---`);
  let ok = 0, failed = 0, searched = 0, lastError = null;

  for (const p of cfg.prompts) {
    try {
      const { text, sources } = await adapter(p.q, engine, key);
      if (!text) throw new Error('empty response body');
      const cited = extractCitations(text, PATTERNS);
      if (sources.length) searched++;
      records.push({
        promptId: p.id,
        engineId: engine.id,
        grounded: Boolean(engine.grounded),
        cited,
        sources: sources.slice(0, 8),
        answer: text.trim().slice(0, ANSWER_CAP),
        queriedAt: new Date().toISOString()
      });
      ok++;
      console.log(`ok   ${p.id}  ${sources.length ? `[${sources.length} src] ` : ''}${cited.join(', ') || '(none cited)'}`);
    } catch (err) {
      failed++;
      lastError = err.message;
      console.error(`FAIL ${p.id}  ${err.message}`);
    }
    await sleep(engine.minDelayMs ?? 1200);
  }

  // A grounded engine that returned no sources on any prompt did not really
  // search. Flag it rather than let it masquerade as retrieval data.
  const groundingWorked = !engine.grounded || searched > 0;
  if (!groundingWorked) {
    console.warn(`WARN  ${engine.name} is configured as grounded but returned no source URLs. Check web-search tool support for ${engine.model}.`);
  }

  engineStatus.push({
    ...engine,
    ran: ok > 0,
    prompts: ok,
    failed,
    promptsWithSources: searched,
    groundingVerified: Boolean(engine.grounded) && searched > 0,
    reason: ok ? (groundingWorked ? null : 'grounding configured but no sources returned')
               : (lastError ?? 'all prompts failed')
  });
}

const activeEngineIds = engineStatus.filter(e => e.ran).map(e => e.id);
if (!activeEngineIds.length) {
  console.error('\nNo engine returned data. Add at least one API key as a repository secret.');
  process.exit(1);
}

/* --------------------------------------------------------------------- write */

const generatedAt = new Date().toISOString();
const scored = computeScores(records, cfg.brands, cfg.prompts.length, activeEngineIds);

const dataDir = new URL('data/', ROOT);
await mkdir(dataDir, { recursive: true });

await writeFile(new URL('latest.json', dataDir), JSON.stringify({
  generatedAt,
  market: cfg.market,
  subject: cfg.subject,
  promptCount: cfg.prompts.length,
  activeEngineIds,
  engines: engineStatus.map(({ secret, ...rest }) => rest),
  records
}, null, 1));

let history = [];
try { history = JSON.parse(await readFile(new URL('history.json', dataDir), 'utf8')); } catch {}
history.push({
  date: generatedAt.slice(0, 10),
  engines: activeEngineIds,
  grounded: engineStatus.filter(e => e.groundingVerified).map(e => e.id),
  scores: Object.fromEntries(scored.map(r => [r.id, Number(r.score.toFixed(2))])),
  hits: Object.fromEntries(scored.map(r => [r.id, r.hits]))
});
await writeFile(new URL('history.json', dataDir), JSON.stringify(history.slice(-104), null, 1));

const subject = scored.find(r => r.id === cfg.subject);
console.log(`\nLive engines: ${activeEngineIds.join(', ')}`);
console.log(`Grounded:     ${engineStatus.filter(e => e.groundingVerified).map(e => e.id).join(', ') || 'none'}`);
console.log(`${subject.name}: ${subject.score.toFixed(1)}/100, rank #${subject.rank} of ${scored.length}`);
console.log(`Wrote data/latest.json and data/history.json (${Math.min(history.length, 104)} snapshots).`);
