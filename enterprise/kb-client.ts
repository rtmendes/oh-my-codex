// InsightProfit Enterprise KB Client
// Shared TypeScript client for the enterprise knowledge base
// Used by: OMC, OMX, Polsio, ThePopeBot, CLI-Anything

interface EnterpriseConfig {
  supabaseUrl: string;
  supabaseKey: string;
}

interface KBEntry {
  id?: string;
  title: string;
  content: string;
  category: 'process' | 'reference' | 'design' | 'api' | 'credential' | 'prompt' | 'template' | 'learning' | 'project' | 'integration' | 'other';
  tags?: string[];
  source?: string;
  source_url?: string;
  metadata?: Record<string, unknown>;
}

interface TaskLog {
  agent_id?: string;
  title: string;
  description?: string;
  department?: string;
  model_used?: string;
  tokens_input?: number;
  tokens_output?: number;
  estimated_cost?: number;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'stalled' | 'cancelled';
  result?: Record<string, unknown>;
  error_log?: string;
  parent_task_id?: string;
  kb_entries_used?: string[];
}

interface AgentHeartbeat {
  agent_id: string;
  status: 'idle' | 'active' | 'stalled' | 'error';
}

class EnterpriseKB {
  private url: string;
  private key: string;
  private headers: Record<string, string>;

  constructor(config?: EnterpriseConfig) {
    this.url = config?.supabaseUrl || process.env.SUPABASE_URL || 'https://supabase.insightprofit.live';
    this.key = config?.supabaseKey || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
    this.headers = {
      'apikey': this.key,
      'Authorization': `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    };
  }

  // ── Knowledge Base ─────────────────────────────────────

  /** Search the KB by text query */
  async searchKB(query: string, maxResults = 10): Promise<KBEntry[]> {
    const res = await fetch(
      `${this.url}/rest/v1/rpc/search_knowledge`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ query, max_results: maxResults }),
      }
    );
    if (!res.ok) throw new Error(`KB search failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** Get KB entries by category */
  async getByCategory(category: string, limit = 50): Promise<KBEntry[]> {
    const res = await fetch(
      `${this.url}/rest/v1/enterprise_knowledge?category=eq.${category}&limit=${limit}&order=updated_at.desc`,
      { headers: this.headers }
    );
    if (!res.ok) throw new Error(`KB fetch failed: ${res.status}`);
    return res.json();
  }

  /** Get KB entries by tags */
  async getByTags(tags: string[], limit = 50): Promise<KBEntry[]> {
    const tagFilter = tags.map(t => `tags.cs.{${t}}`).join(',');
    const res = await fetch(
      `${this.url}/rest/v1/enterprise_knowledge?or=(${tagFilter})&limit=${limit}`,
      { headers: this.headers }
    );
    if (!res.ok) throw new Error(`KB tag fetch failed: ${res.status}`);
    return res.json();
  }

  /** Add entry to the KB */
  async addEntry(entry: KBEntry): Promise<KBEntry> {
    const res = await fetch(
      `${this.url}/rest/v1/enterprise_knowledge`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(entry),
      }
    );
    if (!res.ok) throw new Error(`KB insert failed: ${res.status}`);
    const data = await res.json();
    return data[0];
  }

  // ── Task Logging ───────────────────────────────────────

  /** Log a new task (returns task ID) */
  async logTask(task: TaskLog): Promise<string> {
    const res = await fetch(
      `${this.url}/rest/v1/enterprise_tasks`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ ...task, status: task.status || 'running', started_at: task.started_at || new Date().toISOString() }),
      }
    );
    if (!res.ok) throw new Error(`Task log failed: ${res.status}`);
    const data = await res.json();
    return data[0]?.id;
  }

  /** Update task status + metrics */
  async updateTask(taskId: string, updates: Partial<TaskLog>): Promise<void> {
    const res = await fetch(
      `${this.url}/rest/v1/enterprise_tasks?id=eq.${taskId}`,
      {
        method: 'PATCH',
        headers: this.headers,
        body: JSON.stringify(updates),
      }
    );
    if (!res.ok) throw new Error(`Task update failed: ${res.status}`);
  }

  /** Complete a task with final metrics */
  async completeTask(taskId: string, result: {
    tokens_input?: number;
    tokens_output?: number;
    estimated_cost?: number;
    result?: Record<string, unknown>;
    error_log?: string;
    status?: 'completed' | 'failed';
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.updateTask(taskId, {
      ...result,
      status: result.status || 'completed',
      completed_at: now,
    });
  }

  // ── Agent Heartbeat ────────────────────────────────────

  /** Send agent heartbeat */
  async heartbeat(agentId: string, status: 'idle' | 'active' | 'stalled' | 'error' = 'active'): Promise<void> {
    const res = await fetch(
      `${this.url}/rest/v1/enterprise_agents?id=eq.${agentId}`,
      {
        method: 'PATCH',
        headers: this.headers,
        body: JSON.stringify({ status, last_heartbeat: new Date().toISOString(), updated_at: new Date().toISOString() }),
      }
    );
    if (!res.ok) throw new Error(`Heartbeat failed: ${res.status}`);
  }

  /** Register a new agent */
  async registerAgent(agent: {
    name: string;
    platform: string;
    agent_type?: string;
    department?: string;
    config?: Record<string, unknown>;
  }): Promise<string> {
    const res = await fetch(
      `${this.url}/rest/v1/enterprise_agents`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(agent),
      }
    );
    if (!res.ok) throw new Error(`Agent register failed: ${res.status}`);
    const data = await res.json();
    return data[0]?.id;
  }

  // ── Metrics & Reporting ────────────────────────────────

  /** Get daily cost summary */
  async getDailyCost(date?: string): Promise<Record<string, unknown>> {
    const d = date || new Date().toISOString().split('T')[0];
    const res = await fetch(
      `${this.url}/rest/v1/rpc/daily_cost_summary`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ p_date: d }),
      }
    );
    if (!res.ok) throw new Error(`Cost summary failed: ${res.status}`);
    return res.json();
  }

  /** Get agent performance */
  async getAgentPerformance(agentId: string): Promise<Record<string, unknown>> {
    const res = await fetch(
      `${this.url}/rest/v1/rpc/agent_performance`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ p_agent_id: agentId }),
      }
    );
    if (!res.ok) throw new Error(`Agent performance failed: ${res.status}`);
    return res.json();
  }

  /** Get all active tasks */
  async getActiveTasks(): Promise<TaskLog[]> {
    const res = await fetch(
      `${this.url}/rest/v1/enterprise_tasks?status=in.(queued,running)&order=created_at.desc`,
      { headers: this.headers }
    );
    if (!res.ok) throw new Error(`Active tasks failed: ${res.status}`);
    return res.json();
  }

  /** Get stalled tasks (running > 1h with no update) */
  async getStalledTasks(): Promise<TaskLog[]> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const res = await fetch(
      `${this.url}/rest/v1/enterprise_tasks?status=eq.running&started_at=lt.${oneHourAgo}&order=started_at.asc`,
      { headers: this.headers }
    );
    if (!res.ok) throw new Error(`Stalled tasks failed: ${res.status}`);
    return res.json();
  }

  // ── Health Check ───────────────────────────────────────

  /** Check if Supabase is reachable */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/rest/v1/enterprise_integrations?limit=1`, {
        headers: this.headers,
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export { EnterpriseKB, EnterpriseConfig, KBEntry, TaskLog, AgentHeartbeat };
export default EnterpriseKB;