#!/usr/bin/env node
// OH-MY-ClaudeCode/Codex Enterprise Hook v2
// Auto-queries the EXISTING knowledge_items table (11,590 entries) before every task
// Logs token usage to the EXISTING token_usage table

import EnterpriseKB from './kb-client.js';

const kb = new EnterpriseKB();

interface HookContext {
  task?: string;
  agent?: string;
  agentName?: string;
  department?: string;
  model?: string;
  [key: string]: unknown;
}

/**
 * Pre-task hook: Fetches relevant KB items + auto-inject items.
 * Injects them as context into the agent's prompt.
 */
async function prefetchKnowledge(context: HookContext): Promise<string> {
  try {
    const healthy = await kb.healthCheck();
    if (!healthy) {
      console.warn('[enterprise-kb] Supabase unreachable, skipping KB prefetch');
      return '';
    }

    const taskDescription = context.task || '';
    const contextParts: string[] = [];

    // 1. Get auto-inject items (always included — high priority KB entries)
    const autoItems = await kb.getAutoInjectItems();
    if (autoItems.length > 0) {
      contextParts.push(
        `### Auto-Inject Context (${autoItems.length} items)`,
        ...autoItems.map(e => `**${e.title}**: ${e.content_plain || e.content}`)
      );
    }

    // 2. Search for task-relevant KB entries
    if (taskDescription) {
      const searchResults = await kb.searchKB(taskDescription, 5);
      if (searchResults.length > 0) {
        contextParts.push(
          `### Relevant KB Entries (${searchResults.length} matches)`,
          ...searchResults.map((e, i) =>
            `**${i + 1}. ${e.title}** [${e.tags.join(', ')}]\n${(e.content_plain || e.content).slice(0, 500)}`
          )
        );
      }
    }

    if (contextParts.length === 0) return '';

    // 3. Create dispatch session for tracking
    const sessionId = await kb.createSession({
      id: `${context.agentName || 'agent'}-${Date.now()}`,
      title: taskDescription.slice(0, 200) || 'Agent task',
      department: context.department,
      status: 'running',
    });

    // Store for completion hook
    if (context && sessionId) {
      (context as Record<string, unknown>).__dispatch_session_id = sessionId;
    }

    // Find agent ID for token logging
    const agentName = context.agentName || context.agent || 'OMC Orchestrator';
    const agent = await kb.findAgent(agentName);
    if (agent) {
      (context as Record<string, unknown>).__agent_id = agent.id;
    }

    return `\n---\n📚 Enterprise KB (${autoItems.length} auto-inject + search results):\n\n${contextParts.join('\n\n')}\n---\n`;
  } catch (err) {
    console.error('[enterprise-kb] Prefetch error:', err);
    return '';
  }
}

/**
 * Post-task hook: Logs token usage + updates dispatch session.
 */
async function logCompletion(context: HookContext & {
  __dispatch_session_id?: string;
  __agent_id?: string;
  tokens_input?: number;
  tokens_output?: number;
  model_used?: string;
  success?: boolean;
  error?: string;
}): Promise<void> {
  try {
    const agentId = context.__agent_id;
    const sessionId = context.__dispatch_session_id;
    const model = context.model_used || context.model || 'sonnet';

    // Log token usage
    if (agentId && (context.tokens_input || context.tokens_output)) {
      const cost = EnterpriseKB.calculateCost(
        model,
        context.tokens_input || 0,
        context.tokens_output || 0
      );

      await kb.logTokenUsage({
        agent_id: agentId,
        model,
        input_tokens: context.tokens_input || 0,
        output_tokens: context.tokens_output || 0,
        estimated_cost_usd: cost,
      });
    }

    // Update dispatch session
    if (sessionId) {
      await kb.updateSession(sessionId, {
        status: context.success !== false ? 'completed' : 'failed',
        outcome: context.error || `Completed (${model}, ${(context.tokens_input || 0) + (context.tokens_output || 0)} tokens)`,
      });
    }
  } catch (err) {
    console.error('[enterprise-kb] Completion log error:', err);
  }
}

export { prefetchKnowledge, logCompletion };
export default prefetchKnowledge;