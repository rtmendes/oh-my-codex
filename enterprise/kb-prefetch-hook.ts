#!/usr/bin/env node
// OH-MY-ClaudeCode Enterprise Hook
// Queries the InsightProfit KB before every agent task for relevant context
// Place in: hooks/enterprise-kb-prefetch.ts

import EnterpriseKB from '../enterprise/kb-client.js';

const kb = new EnterpriseKB();

interface HookContext {
  task?: string;
  agent?: string;
  department?: string;
  [key: string]: unknown;
}

/**
 * Pre-task hook: Fetches relevant KB entries and injects them as context.
 * Called automatically before every OMC agent task.
 */
async function prefetchKnowledge(context: HookContext): Promise<string> {
  try {
    // Check KB health
    const healthy = await kb.healthCheck();
    if (!healthy) {
      console.warn('[enterprise-kb] Supabase unreachable, skipping KB prefetch');
      return '';
    }

    const taskDescription = context.task || '';
    if (!taskDescription) return '';

    // Search KB for relevant entries
    const entries = await kb.searchKB(taskDescription, 5);

    if (entries.length === 0) return '';

    // Format as context injection
    const contextBlock = entries.map((e, i) =>
      `### KB Entry ${i + 1}: ${e.title}\n${e.content}\n[source: ${e.source || 'enterprise-kb'} | category: ${e.category}]`
    ).join('\n\n');

    // Log task start
    const taskId = await kb.logTask({
      title: taskDescription,
      department: context.department,
      model_used: context.agent || 'omc-agent',
      kb_entries_used: entries.map(e => e.id!).filter(Boolean),
    });

    // Store taskId for completion hook
    if (context) {
      (context as Record<string, unknown>).__enterprise_task_id = taskId;
    }

    return `\n---\n📚 Enterprise KB Context (${entries.length} relevant entries):\n\n${contextBlock}\n---\n`;
  } catch (err) {
    console.error('[enterprise-kb] Hook error:', err);
    return '';
  }
}

/**
 * Post-task hook: Logs completion metrics.
 */
async function logCompletion(context: HookContext & {
  __enterprise_task_id?: string;
  tokens_input?: number;
  tokens_output?: number;
  model_used?: string;
  success?: boolean;
  error?: string;
}): Promise<void> {
  try {
    const taskId = context.__enterprise_task_id;
    if (!taskId) return;

    // Calculate cost estimate based on model
    const model = context.model_used || 'sonnet';
    const costPerMToken: Record<string, number> = {
      'haiku': 0.25, 'sonnet': 3.0, 'opus': 15.0,
      'gpt-4o': 2.5, 'gpt-4o-mini': 0.15,
    };
    const rate = costPerMToken[model] || 3.0;
    const totalTokens = (context.tokens_input || 0) + (context.tokens_output || 0);
    const cost = (totalTokens / 1_000_000) * rate;

    await kb.completeTask(taskId, {
      tokens_input: context.tokens_input,
      tokens_output: context.tokens_output,
      estimated_cost: cost,
      status: context.success !== false ? 'completed' : 'failed',
      error_log: context.error,
      result: { model: context.model_used },
    });
  } catch (err) {
    console.error('[enterprise-kb] Completion log error:', err);
  }
}

export { prefetchKnowledge, logCompletion };
export default prefetchKnowledge;