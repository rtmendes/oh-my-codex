import { existsSync } from 'fs';
import { readFile, realpath } from 'fs/promises';
import { join, relative, resolve, sep } from 'path';
import { omxStateDir } from '../utils/paths.js';

/**
 * Resolve the canonical OMX team state root for a leader working directory.
 */
export function resolveCanonicalTeamStateRoot(
  leaderCwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.OMX_TEAM_STATE_ROOT;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return resolve(leaderCwd, explicit.trim());
  }
  return resolve(omxStateDir(leaderCwd));
}

export interface TeamWorkerIdentityRef {
  teamName: string;
  workerName: string;
}

export type WorkerTeamStateRootSource =
  | 'env'
  | 'leader_cwd'
  | 'cwd'
  | 'identity_metadata'
  | 'manifest_metadata'
  | 'config_metadata';

export interface WorkerTeamStateRootResolution {
  ok: boolean;
  stateRoot: string | null;
  source: WorkerTeamStateRootSource | null;
  reason?: string;
  identityPath?: string;
  worktreePath?: string;
}

type JsonRecord = Record<string, unknown>;

async function readJsonIfExists(path: string): Promise<JsonRecord | null> {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JsonRecord
      : null;
  } catch {
    return null;
  }
}

function metadataStateRoot(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

async function normalizePath(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

function pathIsSameOrInside(candidate: string, parent: string): boolean {
  if (candidate === parent) return true;
  const rel = relative(parent, candidate);
  return rel !== '' && !rel.startsWith('..') && rel !== '..' && !rel.startsWith(`..${sep}`);
}

async function cwdMatchesIdentityWorktree(cwd: string, identity: JsonRecord): Promise<{ matches: boolean; worktreePath?: string }> {
  const worktreePath = metadataStateRoot(identity.worktree_path);
  if (!worktreePath) return { matches: true };

  const [normalizedCwd, normalizedWorktree] = await Promise.all([
    normalizePath(cwd),
    normalizePath(worktreePath),
  ]);

  return pathIsSameOrInside(normalizedCwd, normalizedWorktree)
    ? { matches: true, worktreePath: normalizedWorktree }
    : { matches: false, worktreePath: normalizedWorktree };
}

async function validateWorkerStateRoot(
  stateRoot: string,
  cwd: string,
  worker: TeamWorkerIdentityRef,
): Promise<WorkerTeamStateRootResolution> {
  const resolvedStateRoot = resolve(cwd, stateRoot);
  const identityPath = join(
    resolvedStateRoot,
    'team',
    worker.teamName,
    'workers',
    worker.workerName,
    'identity.json',
  );
  const identity = await readJsonIfExists(identityPath);
  if (!identity) {
    return {
      ok: false,
      stateRoot: null,
      source: null,
      reason: 'missing_or_invalid_identity',
      identityPath,
    };
  }

  const identityName = metadataStateRoot(identity.name);
  if (identityName && identityName !== worker.workerName) {
    return {
      ok: false,
      stateRoot: null,
      source: null,
      reason: 'identity_worker_mismatch',
      identityPath,
    };
  }

  const worktreeMatch = await cwdMatchesIdentityWorktree(cwd, identity);
  if (!worktreeMatch.matches) {
    return {
      ok: false,
      stateRoot: null,
      source: null,
      reason: 'identity_worktree_mismatch',
      identityPath,
      worktreePath: worktreeMatch.worktreePath,
    };
  }

  return {
    ok: true,
    stateRoot: resolvedStateRoot,
    source: null,
    identityPath,
    worktreePath: worktreeMatch.worktreePath,
  };
}

async function validateWithSource(
  stateRoot: string,
  source: WorkerTeamStateRootSource,
  cwd: string,
  worker: TeamWorkerIdentityRef,
): Promise<WorkerTeamStateRootResolution> {
  const validated = await validateWorkerStateRoot(stateRoot, cwd, worker);
  return validated.ok ? { ...validated, source } : validated;
}

async function readMetadataRootFromValidatedCandidate(
  candidateStateRoot: string,
  filename: 'identity.json' | 'manifest.v2.json' | 'config.json',
  cwd: string,
  worker: TeamWorkerIdentityRef,
): Promise<string | null> {
  const validated = await validateWorkerStateRoot(candidateStateRoot, cwd, worker);
  if (!validated.ok) return null;

  const metadataPath = filename === 'identity.json'
    ? join(candidateStateRoot, 'team', worker.teamName, 'workers', worker.workerName, filename)
    : join(candidateStateRoot, 'team', worker.teamName, filename);
  const parsed = await readJsonIfExists(metadataPath);
  return metadataStateRoot(parsed?.team_state_root);
}

/**
 * Resolve the canonical team state root for an OMX team worker hook.
 *
 * This resolver is intentionally fail-closed: every successful source must have
 * a valid worker identity and, when present, whose worktree path matches the hook cwd/current
 * worktree. It prevents hooks running inside worker worktrees from guessing a
 * local `.omx/state` root and writing cross-worker runtime state in the wrong
 * place.
 */
export async function resolveWorkerTeamStateRoot(
  cwd: string,
  worker: TeamWorkerIdentityRef,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerTeamStateRootResolution> {
  const explicit = typeof env.OMX_TEAM_STATE_ROOT === 'string' ? env.OMX_TEAM_STATE_ROOT.trim() : '';
  if (explicit) {
    const resolved = await validateWithSource(resolve(cwd, explicit), 'env', cwd, worker);
    if (resolved.ok) return resolved;
    return { ...resolved, source: 'env' };
  }

  const leaderCwd = typeof env.OMX_TEAM_LEADER_CWD === 'string' ? env.OMX_TEAM_LEADER_CWD.trim() : '';
  const leaderStateRoot = leaderCwd ? join(resolve(cwd, leaderCwd), '.omx', 'state') : '';
  if (leaderStateRoot) {
    const resolved = await validateWithSource(leaderStateRoot, 'leader_cwd', cwd, worker);
    if (resolved.ok) return resolved;
  }

  const cwdStateRoot = join(cwd, '.omx', 'state');
  const cwdResolved = await validateWithSource(cwdStateRoot, 'cwd', cwd, worker);
  if (cwdResolved.ok) return cwdResolved;

  const metadataCandidateRoots = [leaderStateRoot, cwdStateRoot].filter(Boolean);
  const metadataSources: Array<[
    'identity.json' | 'manifest.v2.json' | 'config.json',
    WorkerTeamStateRootSource,
  ]> = [
    ['identity.json', 'identity_metadata'],
    ['manifest.v2.json', 'manifest_metadata'],
    ['config.json', 'config_metadata'],
  ];

  for (const [filename, source] of metadataSources) {
    for (const candidateRoot of metadataCandidateRoots) {
      const metadataRoot = await readMetadataRootFromValidatedCandidate(candidateRoot, filename, cwd, worker);
      if (!metadataRoot) continue;
      const resolved = await validateWithSource(resolve(cwd, metadataRoot), source, cwd, worker);
      if (resolved.ok) return resolved;
    }
  }

  return {
    ok: false,
    stateRoot: null,
    source: null,
    reason: cwdResolved.reason || 'no_valid_worker_state_root',
    identityPath: cwdResolved.identityPath,
  };
}

export async function resolveWorkerTeamStateRootPath(
  cwd: string,
  worker: TeamWorkerIdentityRef,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const resolved = await resolveWorkerTeamStateRoot(cwd, worker, env);
  return resolved.ok ? resolved.stateRoot : null;
}
