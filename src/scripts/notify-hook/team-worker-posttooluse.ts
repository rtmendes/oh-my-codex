import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";
import { normalizePostToolUsePayload } from "../codex-native-pre-post.js";
import { resolveWorkerTeamStateRoot } from "../../team/state-root.js";

type CodexHookPayload = Record<string, unknown>;

export interface TeamWorkerPostToolUseResult {
  handled: boolean;
  status: "applied" | "noop" | "conflict" | "skipped";
  reason?: string;
  teamName?: string;
  workerName?: string;
  stateRoot?: string;
  worktreePath?: string;
  workerHeadBefore?: string | null;
  workerHeadAfter?: string | null;
  checkpointCommit?: string | null;
  leaderHeadObserved?: string | null;
  operationKinds: Array<"auto_checkpoint" | "worker_clean_rebase" | "leader_integration_attempt">;
  dedupeKey?: string;
}

interface ParsedTeamWorker {
  teamName: string;
  workerName: string;
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readHookEventName(payload: CodexHookPayload): string {
  return safeString(
    payload.hook_event_name
    ?? payload.hookEventName
    ?? payload.event
    ?? payload.name,
  ).trim();
}

function parseTeamWorkerEnv(rawValue: unknown): ParsedTeamWorker | null {
  const raw = safeString(rawValue).trim();
  const match = /^([a-z0-9][a-z0-9-]{0,29})\/(worker-\d+)$/.exec(raw);
  if (!match) return null;
  return { teamName: match[1], workerName: match[2] };
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await rename(tmpPath, path);
}

function workerDir(stateRoot: string, teamName: string, workerName: string): string {
  return join(stateRoot, "team", teamName, "workers", workerName);
}

async function updatePostToolUseHeartbeat(params: {
  stateRoot: string;
  teamName: string;
  workerName: string;
  nowIso: string;
}): Promise<void> {
  const heartbeatPath = join(workerDir(params.stateRoot, params.teamName, params.workerName), "heartbeat.json");
  const existing = await readJsonIfExists(heartbeatPath);
  const previousCount = typeof existing?.turn_count === "number" && Number.isFinite(existing.turn_count)
    ? existing.turn_count
    : 0;
  await writeJsonAtomic(heartbeatPath, {
    ...existing,
    pid: process.ppid || process.pid,
    last_turn_at: params.nowIso,
    last_post_tool_use_at: params.nowIso,
    turn_count: previousCount + 1,
    alive: true,
    source: "posttooluse",
  });
}

async function writePostToolUseEvidence(params: {
  stateRoot: string;
  teamName: string;
  workerName: string;
  cwd: string;
  nowIso: string;
  toolUseId: string;
  command: string;
  dedupeKey: string;
}): Promise<void> {
  const evidencePath = join(workerDir(params.stateRoot, params.teamName, params.workerName), "posttooluse.json");
  await writeJsonAtomic(evidencePath, {
    version: 1,
    updated_at: params.nowIso,
    source: "native-posttooluse",
    worker: params.workerName,
    cwd: params.cwd,
    last_success: {
      at: params.nowIso,
      tool_use_id: params.toolUseId || null,
      command: params.command || null,
      dedupe_key: params.dedupeKey,
    },
  });
}

async function checkpointIfEligible(cwd: string, workerName: string): Promise<{
  status: PostToolUseStatus;
  reason?: string;
  checkpointCommit: string | null;
  workerHeadAfter: string | null;
}> {
  const inProgress = await hasGitOperationInProgress(cwd);
  if (inProgress) {
    return { status: inProgress === 'not_git_repository' ? 'skipped' : 'skipped', reason: inProgress, checkpointCommit: null, workerHeadAfter: await gitHead(cwd) };
  }

  const unmerged = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
  if (unmerged.trim()) {
    return { status: 'conflict', reason: 'unmerged_paths', checkpointCommit: null, workerHeadAfter: await gitHead(cwd) };
  }

  const status = await git(cwd, ['status', '--porcelain=v1', '-uall']);
  const paths = parsePorcelainPaths(status);
  if (paths.length === 0) {
    return { status: 'noop', checkpointCommit: null, workerHeadAfter: await gitHead(cwd) };
  }

  const checkpointable = paths.filter((path) => !isProtectedCheckpointPath(path));
  if (checkpointable.length === 0) {
    const onlyHookState = paths.every((path) => path.replace(/\\/g, '/').startsWith('.omx/state/'));
    return onlyHookState
      ? { status: 'noop', checkpointCommit: null, workerHeadAfter: await gitHead(cwd) }
      : { status: 'skipped', reason: 'only_protected_paths_changed', checkpointCommit: null, workerHeadAfter: await gitHead(cwd) };
  }

  const addResult = await gitMaybe(cwd, ['add', '--', ...checkpointable]);
  if (!addResult.ok) return { status: 'skipped', reason: `git_add_failed:${addResult.stderr.slice(0, 120)}`, checkpointCommit: null, workerHeadAfter: await gitHead(cwd) };

  const commitResult = await gitMaybe(cwd, ['commit', '--no-verify', '-m', `omx(team): auto-checkpoint ${workerName}`]);
  if (!commitResult.ok) {
    const reason = commitResult.stderr.includes('conflict') ? 'git_commit_conflict' : `git_commit_failed:${commitResult.stderr.slice(0, 120)}`;
    return { status: reason.includes('conflict') ? 'conflict' : 'skipped', reason, checkpointCommit: null, workerHeadAfter: await gitHead(cwd) };
  }

  const head = await gitHead(cwd);
  return { status: 'applied', checkpointCommit: head, workerHeadAfter: head };
}

async function logBridgeFailure(cwd: string, reason: string): Promise<void> {
  try {
    const logsDir = join(cwd, ".omx", "logs", "notify-hook");
    await mkdir(logsDir, { recursive: true });
    await appendFile(
      join(logsDir, "team-worker-posttooluse.ndjson"),
      `${JSON.stringify({ at: new Date().toISOString(), reason })}\n`,
      "utf-8",
    );
  } catch {
    // Best-effort only; the native hook output must not be affected by bridge logging.
  }
}

function skipped(reason: string, parsed?: Partial<ParsedTeamWorker>): TeamWorkerPostToolUseResult {
  return {
    handled: false,
    status: "skipped",
    reason,
    teamName: parsed?.teamName,
    workerName: parsed?.workerName,
    operationKinds: [],
  };
}

/**
 * Best-effort team-worker bridge for successful Bash PostToolUse events.
 *
 * The bridge is intentionally side-effect-only: it updates worker-local freshness
 * evidence in the canonical team state root and never blocks/denies the native
 * hook result. Git checkpoint/rebase/integration scaffolding is layered on top
 * of this shell by the dedicated clean-scaffolding lane.
 */
export async function handleTeamWorkerPostToolUseSuccess(
  payload: CodexHookPayload,
  cwd: string,
): Promise<TeamWorkerPostToolUseResult> {
  try {
    if (readHookEventName(payload) !== "PostToolUse") return skipped("not_posttooluse");

    const normalized = normalizePostToolUsePayload(payload);
    if (!normalized.isBash) return skipped("not_bash");
    if (normalized.exitCode !== 0) return skipped("nonzero_exit");

    const parsedWorker = parseTeamWorkerEnv(process.env.OMX_TEAM_WORKER);
    if (!parsedWorker) return skipped("missing_worker_identity");

    const resolved = await resolveWorkerTeamStateRoot(cwd, parsedWorker, process.env);
    if (!resolved.ok || !resolved.stateRoot) {
      return skipped(resolved.reason || "state_root_unresolved", parsedWorker);
    }

    const nowIso = new Date().toISOString();
    const toolUseId = normalized.toolUseId;
    const dedupeKey = [
      "posttooluse",
      parsedWorker.teamName,
      parsedWorker.workerName,
      toolUseId || normalized.command || nowIso,
    ].join(":");

    await updatePostToolUseHeartbeat({
      stateRoot: resolved.stateRoot,
      teamName: parsedWorker.teamName,
      workerName: parsedWorker.workerName,
      nowIso,
    });
    await writePostToolUseEvidence({
      stateRoot: resolved.stateRoot,
      teamName: parsedWorker.teamName,
      workerName: parsedWorker.workerName,
      cwd,
      nowIso,
      toolUseId,
      command: normalized.command,
      dedupeKey,
    });
    await appendPostToolUseEvent({
      stateRoot: resolved.stateRoot,
      teamName: parsedWorker.teamName,
      workerName: parsedWorker.workerName,
      nowIso,
      dedupeKey,
      toolUseId,
      cwd,
    });

    return {
      handled: true,
      status: "noop",
      reason: "worker_posttooluse_evidence_recorded",
      teamName: parsedWorker.teamName,
      workerName: parsedWorker.workerName,
      stateRoot: resolved.stateRoot,
      worktreePath: resolved.worktreePath,
      workerHeadBefore: null,
      workerHeadAfter: null,
      checkpointCommit: null,
      leaderHeadObserved: null,
      operationKinds: [],
      dedupeKey,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await logBridgeFailure(cwd, reason);
    return skipped(reason);
  }
}
