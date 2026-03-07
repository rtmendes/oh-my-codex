import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const rootAgents = readFileSync(join(__dirname, '../../../AGENTS.md'), 'utf-8');
const templateAgents = readFileSync(join(__dirname, '../../../templates/AGENTS.md'), 'utf-8');
const executorPrompt = readFileSync(join(__dirname, '../../../prompts/executor.md'), 'utf-8');
const plannerPrompt = readFileSync(join(__dirname, '../../../prompts/planner.md'), 'utf-8');
const verifierPrompt = readFileSync(join(__dirname, '../../../prompts/verifier.md'), 'utf-8');

const COMPACT_PATTERN = /compact, information-dense responses/i;
const FOLLOW_THROUGH_PATTERN = /clear, low-risk, reversible next steps/i;
const OVERRIDE_PATTERN = /local overrides?.*non-conflicting instructions/i;
const TOOL_PERSISTENCE_PATTERN = /do not skip prerequisites|task is grounded and verified/i;
const CONCISE_EVIDENCE_PATTERN = /concise evidence summaries/i;

describe('prompt guidance contract for root/template orchestration surfaces', () => {
  for (const [label, content] of [
    ['AGENTS.md', rootAgents],
    ['templates/AGENTS.md', templateAgents],
  ] as const) {
    it(`${label} encodes compact output defaults`, () => {
      assert.match(content, COMPACT_PATTERN);
    });

    it(`${label} encodes follow-through for low-risk reversible next steps`, () => {
      assert.match(content, FOLLOW_THROUGH_PATTERN);
    });

    it(`${label} encodes localized task-update overrides`, () => {
      assert.match(content, OVERRIDE_PATTERN);
    });

    it(`${label} encodes dependency-aware tool persistence`, () => {
      assert.match(content, TOOL_PERSISTENCE_PATTERN);
    });

    it(`${label} keeps concise evidence-summary guidance in verification`, () => {
      assert.match(content, CONCISE_EVIDENCE_PATTERN);
    });
  }
});

describe('prompt guidance contract for selected role prompts', () => {
  it('executor prompt encodes compact output, local overrides, and tool persistence', () => {
    assert.match(executorPrompt, /compact, information-dense outputs/i);
    assert.match(executorPrompt, /local overrides?.*non-conflicting constraints/i);
    assert.match(executorPrompt, /keep using them until the task is grounded and verified/i);
  });

  it('planner prompt encodes compact planning summaries, local overrides, and evidence-grounded planning', () => {
    assert.match(plannerPrompt, /compact, information-dense plan summaries/i);
    assert.match(plannerPrompt, /local overrides?.*non-conflicting constraints/i);
    assert.match(plannerPrompt, /keep using them until the plan is grounded in evidence/i);
  });

  it('verifier prompt encodes concise evidence-dense reporting, tool persistence, and local override handling', () => {
    assert.match(verifierPrompt, /concise, evidence-dense summaries/i);
    assert.match(verifierPrompt, /keep using those tools until the verdict is grounded/i);
    assert.match(verifierPrompt, /apply that override locally without discarding earlier non-conflicting acceptance criteria/i);
  });
});
