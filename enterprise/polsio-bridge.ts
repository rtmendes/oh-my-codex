// OH-MY-ClaudeCode/Codex → Polsio Enterprise Bridge
// When OMC/OMX agents need to spawn work on other platforms,
// they submit tasks through Polsio's enterprise queue.

import EnterpriseKB from './kb-client.js';

const kb = new EnterpriseKB();

interface CrossPlatformTask {
  title: string;
  description?: string;
  department?: string;
  priority?: number;
  target_platform?: 'polsio' | 'thepopebot' | 'viktor' | 'cli-anything' | 'dispatch';
  target_agent?: string;
  kb_tags?: string[];
  payload?: Record<string, unknown>;
}

class EnterpriseBridge {
  private polsioUrl: string;
  private platform: 'omx' | 'omx';

  constructor(platform: 'omx' | 'omx' = 'omx') {
    this.polsioUrl = process.env.POLSIO_ENTERPRISE_URL || 'http://localhost:3001/enterprise';
    this.platform = platform;
  }

  /** Submit a cross-platform task through Polsio's enterprise queue */
  async submitTask(task: CrossPlatformTask): Promise<{
    success: boolean;
    session_id?: string;
    queued?: boolean;
    error?: string;
  }> {
    try {
      // Try Polsio first
      const res = await fetch(`${this.polsioUrl}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...task,
          source_platform: this.platform,
          source_agent: this.platform === 'omx' ? 'OMX Orchestrator' : 'OMX Orchestrator',
        }),
      });

      if (res.ok) return res.json();

      // Fallback: create dispatch session directly
      const sessionId = await kb.createSession({
        id: `${this.platform}-${Date.now()}`,
        title: task.title,
        department: task.department,
      });

      return { success: true, session_id: sessionId || undefined, queued: false };
    } catch (err: any) {
      // Direct Supabase fallback
      const sessionId = await kb.createSession({
        id: `${this.platform}-fallback-${Date.now()}`,
        title: task.title,
        department: task.department,
      });
      return { success: true, session_id: sessionId || undefined, queued: false, error: 'Polsio unreachable, used direct fallback' };
    }
  }

  /** Get enterprise-wide status */
  async getEnterpriseStatus(): Promise<any> {
    try {
      const res = await fetch(`${this.polsioUrl}/status`);
      if (res.ok) return res.json();
    } catch {}
    // Fallback to direct KB query
    return kb.getDashboardData();
  }

  /** Search enterprise KB */
  async searchKB(query: string, limit = 10): Promise<any[]> {
    return kb.searchKB(query, limit);
  }

  /** Report task completion with token metrics */
  async reportCompletion(sessionId: string, metrics: {
    tokens_input?: number;
    tokens_output?: number;
    model?: string;
    success?: boolean;
    outcome?: string;
  }): Promise<void> {
    try {
      await fetch(`${this.polsioUrl}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          status: metrics.success !== false ? 'completed' : 'failed',
          outcome: metrics.outcome,
          tokens_input: metrics.tokens_input,
          tokens_output: metrics.tokens_output,
          model: metrics.model,
        }),
      });
    } catch {
      // Direct Supabase fallback
      await kb.updateSession(sessionId, {
        status: metrics.success !== false ? 'completed' : 'failed',
        outcome: metrics.outcome,
      });
    }
  }
}

export { EnterpriseBridge, CrossPlatformTask };
export default EnterpriseBridge;