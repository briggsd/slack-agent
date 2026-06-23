import { SqliteSessionStore } from '../dist/sessions/store.js';
import { gradeDecisions } from '../dist/telemetry/grade-decisions.js';

const usage = [
  'Usage: node scripts/grade-decisions.mjs --db <sqlite-path> [--since <epoch-ms>] [--limit <n>]',
  'Env: ANTHROPIC_API_KEY is required. ANTHROPIC_MODEL overrides the default model id.',
].join('\n');

function parseIntegerFlag(name, value) {
  if (value === undefined) throw new Error(`missing value for ${name}`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`invalid integer for ${name}: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') {
      const value = argv[i + 1];
      if (!value) throw new Error('missing value for --db');
      parsed.db = value;
      i += 1;
      continue;
    }
    if (arg === '--since') {
      parsed.sinceMs = parseIntegerFlag('--since', argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--limit') {
      parsed.limit = parseIntegerFlag('--limit', argv[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!parsed.db) throw new Error('--db is required');
  return parsed;
}

function extractResponseText(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Anthropic response was not an object');
  }
  const content = data.content;
  if (!Array.isArray(content)) {
    throw new Error('Anthropic response content was not an array');
  }
  for (const block of content) {
    if (
      block
      && typeof block === 'object'
      && block.type === 'text'
      && typeof block.text === 'string'
    ) {
      return block.text;
    }
  }
  throw new Error('Anthropic response did not include a text block');
}

function parseGradeResult(text) {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const parsed = JSON.parse(unfenced);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('grader response JSON was not an object');
  }
  const verdict = parsed.verdict;
  const gaps = parsed.gaps;
  if (verdict !== 'clear' && verdict !== 'thin' && verdict !== 'opaque') {
    throw new Error(`invalid verdict: ${String(verdict)}`);
  }
  if (typeof gaps !== 'string') {
    throw new Error('gaps must be a string');
  }
  return { verdict, gaps };
}

function buildPrompt(decision) {
  return [
    'Grade whether this autonomous decision rationale is adequately justified.',
    'Rubric: can the decision be explained, are failure modes addressed, does it cite the SPEC or acceptance criteria, and are any compliance flags surfaced?',
    'Return strict JSON only: {"verdict":"clear|thin|opaque","gaps":"concise gap findings"}',
    '',
    `profile_id: ${decision.profile_id ?? 'null'}`,
    `tool: ${decision.tool ?? 'null'}`,
    `result: ${decision.result ?? 'null'}`,
    'reasoning:',
    decision.reasoning,
  ].join('\n');
}

async function main() {
  const { db, sinceMs, limit } = parseArgs(process.argv.slice(2));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
  const store = new SqliteSessionStore(db);

  try {
    const summary = await gradeDecisions({
      store,
      ...(sinceMs !== undefined ? { sinceMs } : {}),
      ...(limit !== undefined ? { limit } : {}),
      grade: async (decision) => {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: 200,
            temperature: 0,
            system: 'You are a senior engineer grading whether captured autonomous decision reasoning is legible and justified.',
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: buildPrompt(decision),
                  },
                ],
              },
            ],
          }),
        });

        if (!response.ok) {
          throw new Error(`Anthropic API error ${response.status}`);
        }

        const data = await response.json();
        return parseGradeResult(extractResponseText(data));
      },
    });

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    store.close();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  console.error(usage);
  process.exitCode = 1;
});
