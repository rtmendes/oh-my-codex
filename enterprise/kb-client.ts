// InsightProfit Enterprise KB Client v2
// Wires into EXISTING Supabase tables (not enterprise_* prefixed)
//
// Existing tables used:
//   knowledge_items (11,590 entries) — shared KB with tags, auto_inject, injection_priority
//   agents (15 registered) — agent fleet registry
//   token_usage — per-call token + cost tracking
//   dispatch_sessions — task tracking with department + status
//   infra_current_status — live infrastructure health
//   agent_sessions — session tracking
//   agent_memory — persistent agent memory

interface EnterpriseConfig {
  supabaseUrl: string;
  supabaseKey: string;
}

interface KBItem {
  id: string;
  title: string;
  content: string;
  content_plain?: string;
  item_type: string;
  tags: string[];
  category_id?: string;
  auto_inject: boolean;
  injection_priority: number;
  status: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface Agent {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'idle' | 'error';
  created_at: string;
  updated_at: string;
}

interface TokenUsageEntry {
  agent_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
}

interface DispatchSession {
  id: string;
  title: string;
  status: string;
  outcome?: string;
  department?: string;
  started_at: string;
  updated_at: string;
}

class EnterpriseKB {
  private url: string;
  private key: string;
  private headers: Record<string, string>;

  constructor(config?: EnterpriseConfig) {
    this.url = config?.supabaseUrl || process.env.SUPABASE_URL || 'https://supabase.insightprofit.live';
    this.key = config?.supabaseKey || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
    this.headers = {
      'apikey': this.key,
      'Authorization': `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    };
  }

  // ── Knowledge Base (11,590 entries in knowledge_items) ──

  /** Full-text search across all KB items */
  async searchKB(query: string, limit = 10): Promise<KBItem[]> {
    // Use PostgREST full-text search on content + title
    const words = query.trim().split(/\s+/).join('+');
    const res = await fetch(
      `${this.url}/rest/v1/knowledge_items?or=(content.fts.${words},title.fts.${words})&status=eq.active&order=injection_priority.desc,updated_at.desc&limit=${limit}`,
      { headers: this.headers }
    );
    if (!res.ok) {
      // Fallback to ilike search
      const res2 = await fetch(
        `${this.url}/rest/v1/knowledge_items?or=(content.ilike.*${encodeURIComponent(query)}*,title.ilike.*${encodeURIComponent(query)}*)&status=eq.active&order=updated_at.desc&limit=${limit}`,
        { headers: this.headers }
      );
      if (!res2.ok) return [];
      return res2.json();
    }
    return res.json();
  }

  /** Get items flagged for auto-injection (auto_inject = true) */
  async getAutoInjectItems(): Promise<KBItem[]> {
    const res = await fetch(
      `${this.url}/rest/v1/knowledge_items?auto_inject=eq.true&status=eq.active&order=injection_priority.desc`,
      { headers: this.headers }
    );
    if (!res.ok) return [];
    return res.json();
  }

  /** Get KB items by tags */
  async getByTags(tags: string[], limit = 50): Promise<KBItem[]> {
    const tagFilter = tags.map(t => `tags.cs.{${t}}`).join(',');
    const res = await fetch(
      `${this.url}/rest/v1/knowledge_items?or=(${tagFilter})&status=eq.active&limit=${limit}`,
      { headers: this.headers }
    );
    if (!res.ok) return [];
    return res.json();
  }

  /** Add a new KB item */
  async addKBItem(item: Partial<KBItem>): Promise<KBItem | null> {
    const res = await fetch(
      `${this.url}/rest/v1/knowledge_items`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          title: item.title,
          content: item.content,
          content_plain: item.content_plain || item.content,
          item_type: item.item_type || 'reference',
          tags: item.tags || [],
          auto_inject: item.auto_inject || false,
          injection_priority: item.injection_priority || 50,
          status: 'active',
          metadata: item.metadata || {},
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data[0];
  }

  /** Get total KB stats */
  async getKBStats(): Promise<{ total: number; byType: Record<string, number> }> {
    const res = await fetch(
      `${this.url}/rest/v1/knowledge_items?select=item_type&status=eq.active`,
      { headers: this.headers }
    );
    if (!res.ok) return { total: 0, byType: {} };
    const items: { item_type: string }[] = await res.json();
    const byType: Record<string, number> = {};
    for (const i of items) {
      byType[i.item_type] = (byType[i.item_type] || 0) + 1;
    }
    return { total: items.length, byType };
  }

  // ── Agent Fleet (agents table) ─────────────────────────

  /** Get all registered agents */
  async getAgents(): Promise<Agent[]> {
    const res = await fetch(
      `${this.url}/rest/v1/agents?order=name`,
      { headers: this.headers }
    );
    if (!res.ok) return [];
    return res.json();
  }

  /** Get agents by status */
  async getAgentsByStatus(status: string): Promise<Agent[]> {
    const res = await fetch(
      `${this.url}/rest/v1/agents?status=eq.${status}`,
      { headers: this.headers }
    );
    if (!res.ok) return [];
    return res.json();
  }

  /** Update agent status */
  async updateAgentStatus(agentId: string, status: string): Promise<void> {
    await fetch(
      `${this.url}/rest/v1/agents?id=eq.${agentId}`,
      {
        method: 'PATCH',
        headers: this.headers,
        body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
      }
    );
  }

  /** Find agent by name */
  async findAgent(name: string): Promise<Agent | null> {
    const res = await fetch(
      `${this.url}/rest/v1/agents?name=eq.${encodeURIComponent(name)}&limit=1`,
      { headers: this.headers }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data[0] || null;
  }

  // ── Token Usage Tracking ───────────────────────────────

  /** Log token usage for an agent call */
  async logTokenUsage(entry: TokenUsageEntry): Promise<void> {
    await fetch(
      `${this.url}/rest/v1/token_usage`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(entry),
      }
    );
  }

  /** Get token usage for an agent (today) */
  async getAgentTokenUsage(agentId: string): Promise<{
    total_input: number; total_output: number; total_cost: number; call_count: number;
  }> {
    const today = new Date().toISOString().split('T')[0];
    const res = await fetch(
      `${this.url}/rest/v1/token_usage?agent_id=eq.${agentId}&created_at=gte.${today}T00:00:00`,
      { headers: this.headers }
    );
    if (!res.ok) return { total_input: 0, total_output: 0, total_cost: 0, call_count: 0 };
    const rows: any[] = await res.json();
    return {
      total_input: rows.reduce((s, r) => s + (r.input_tokens || 0), 0),
      total_output: rows.reduce((s, r) => s + (r.output_tokens || 0), 0),
      total_cost: rows.reduce((s, r) => s + parseFloat(r.estimated_cost_usd || 0), 0),
      call_count: rows.length,
    };
  }

  /** Get enterprise-wide token usage summary (today) */
  async getDailyTokenSummary(): Promise<{
    total_tokens: number; total_cost: number; call_count: number;
    by_model: Record<string, { tokens: number; cost: number; calls: number }>;
    by_agent: Record<string, { tokens: number; cost: number; calls: number }>;
  }> {
    const today = new Date().toISOString().split('T')[0];
    const res = await fetch(
      `${this.url}/rest/v1/token_usage?created_at=gte.${today}T00:00:00`,
      { headers: this.headers }
    );
    if (!res.ok) return { total_tokens: 0, total_cost: 0, call_count: 0, by_model: {}, by_agent: {} };
    const rows: any[] = await res.json();
    const by_model: Record<string, { tokens: number; cost: number; calls: number }> = {};
    const by_agent: Record<string, { tokens: number; cost: number; calls: number }> = {};

    for (const r of rows) {
      const t = (r.input_tokens || 0) + (r.output_tokens || 0);
      const c = parseFloat(r.estimated_cost_usd || 0);

      // By model
      if (!by_model[r.model]) by_model[r.model] = { tokens: 0, cost: 0, calls: 0 };
      by_model[r.model].tokens += t;
      by_model[r.model].cost += c;
      by_model[r.model].calls += 1;

      // By agent
      const aid = r.agent_id || 'unknown';
      if (!by_agent[aid]) by_agent[aid] = { tokens: 0, cost: 0, calls: 0 };
      by_agent[aid].tokens += t;
      by_agent[aid].cost += c;
      by_agent[aid].calls += 1;
    }

    return {
      total_tokens: rows.reduce((s, r) => s + (r.input_tokens || 0) + (r.output_tokens || 0), 0),
      total_cost: rows.reduce((s, r) => s + parseFloat(r.estimated_cost_usd || 0), 0),
      call_count: rows.length,
      by_model,
      by_agent,
    };
  }

  // ── Dispatch Sessions (task tracking) ──────────────────

  /** Get active dispatch sessions */
  async getActiveSessions(): Promise<DispatchSession[]> {
    const res = await fetch(
      `${this.url}/rest/v1/dispatch_sessions?status=in.(running,pending,in_progress)&order=updated_at.desc`,
      { headers: this.headers }
    );
    if (!res.ok) return [];
    return res.json();
  }

  /** Get stalled sessions (not updated in 1+ hours) */
  async getStalledSessions(): Promise<DispatchSession[]> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const res = await fetch(
      `${this.url}/rest/v1/dispatch_sessions?status=in.(running,pending,in_progress)&updated_at=lt.${oneHourAgo}`,
      { headers: this.headers }
    );
    if (!res.ok) return [];
    return res.json();
  }

  /** Get recent completed sessions */
  async getRecentSessions(limit = 20): Promise<DispatchSession[]> {
    const res = await fetch(
      `${this.url}/rest/v1/dispatch_sessions?order=updated_at.desc&limit=${limit}`,
      { headers: this.headers }
    );
    if (!res.ok) return [];
    return res.json();
  }

  /** Create a new dispatch session */
  async createSession(session: Partial<DispatchSession>): Promise<string | null> {
    const res = await fetch(
      `${this.url}/rest/v1/dispatch_sessions`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          id: session.id || `task-${Date.now()}`,
          title: session.title,
          status: session.status || 'running',
          department: session.department,
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data[0]?.id;
  }

  /** Update dispatch session */
  async updateSession(sessionId: string, updates: Partial<DispatchSession>): Promise<void> {
    await fetch(
      `${this.url}/rest/v1/dispatch_sessions?id=eq.${encodeURIComponent(sessionId)}`,
      {
        method: 'PATCH',
        headers: this.headers,
        body: JSON.stringify({ ...updates, updated_at: new Date().toISOString() }),
      }
    );
  }

  // ── Infrastructure Health ──────────────────────────────

  /** Get current infrastructure status */
  async getInfraStatus(): Promise<Array<{
    service: string; status: string; response_time_ms: number;
    message: string; checked_at: string;
  }>> {
    const res = await fetch(
      `${this.url}/rest/v1/infra_current_status?order=service`,
      { headers: this.headers }
    );
    if (!res.ok) return [];
    return res.json();
  }

  // ── Dashboard Aggregation ──────────────────────────────

  /** Single call to get everything Mission Control needs */
  async getDashboardData(): Promise<{
    agents: Agent[];
    activeSessions: DispatchSession[];
    recentSessions: DispatchSession[];
    tokenSummary: any;
    infraStatus: any[];
    kbStats: { total: number; byType: Record<string, number> };
  }> {
    const [agents, activeSessions, recentSessions, tokenSummary, infraStatus, kbStats] = await Promise.all([
      this.getAgents(),
      this.getActiveSessions(),
      this.getRecentSessions(20),
      this.getDailyTokenSummary(),
      this.getInfraStatus(),
      this.getKBStats(),
    ]);
    return { agents, activeSessions, recentSessions, tokenSummary, infraStatus, kbStats };
  }

  // ── Convenience: Model Cost Calculator ─────────────────

  /** Calculate estimated cost based on model */
  static calculateCost(model: string, inputTokens: number, outputTokens: number): number {
    const rates: Record<string, [number, number]> = {
      // [input_per_MTok, output_per_MTok]
      'haiku':       [0.25, 1.25],
      'sonnet':      [3.00, 15.00],
      'opus':        [15.00, 75.00],
      'gpt-4o':      [2.50, 10.00],
      'gpt-4o-mini': [0.15, 0.60],
      'gpt-4.1':     [2.00, 8.00],
      'gpt-4.1-mini':[0.40, 1.60],
      'o3':          [10.00, 40.00],
      'o4-mini':     [1.10, 4.40],
      'codex':       [3.00, 15.00],
      'deepseek':    [0.27, 1.10],
    };
    const [iRate, oRate] = rates[model.toLowerCase()] || [3.00, 15.00];
    return (inputTokens / 1_000_000) * iRate + (outputTokens / 1_000_000) * oRate;
  }

  // ── Health Check ───────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/rest/v1/agents?limit=1`, { headers: this.headers });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export { EnterpriseKB, KBItem, Agent, TokenUsageEntry, DispatchSession };
export default EnterpriseKB;