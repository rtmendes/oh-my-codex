import { strict as assert } from "assert";
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleTeamWorkerPostToolUseSuccess } from "../team-worker-posttooluse.js";
import { dispatchCodexNativeHook } from "../../codex-native-hook.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.OMX_TEAM_WORKER;
  delete process.env.OMX_TEAM_STATE_ROOT;
  delete process.env.OMX_TEAM_LEADER_CWD;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function setupWorkerState(): Promise<{ cwd: string; stateRoot: string; teamName: string; workerName: string }> {
  const root = await mkdtemp(join(tmpdir(), "omx-posttooluse-worker-"));
  const cwd = join(root, "worktree");
  const stateRoot = join(root, "state");
  const teamName = "ptu-team";
  const workerName = "worker-2";
  await mkdir(cwd, { recursive: true });
  await writeJson(join(stateRoot, "team", teamName, "workers", workerName, "identity.json"), {
    name: workerName,
    team_name: teamName,
    team_state_root: stateRoot,
    worktree_path: cwd,
  });
  process.env.OMX_TEAM_WORKER = `${teamName}/${workerName}`;
  process.env.OMX_TEAM_STATE_ROOT = stateRoot;
  return { cwd, stateRoot, teamName, workerName };
}

function successPayload(): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "tool-1",
    tool_input: { command: "echo ok" },
    tool_response: { exit_code: 0, stdout: "ok\n" },
  };
}

describe("team worker PostToolUse bridge", () => {
  it("skips non-worker and non-success cases without guessed state writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "omx-posttooluse-skip-"));
    const missingWorker = await handleTeamWorkerPostToolUseSuccess(successPayload(), root);
    assert.equal(missingWorker.handled, false);
    assert.equal(missingWorker.status, "skipped");
    assert.equal(missingWorker.reason, "missing_worker_identity");

    process.env.OMX_TEAM_WORKER = "ptu-team/worker-2";
    process.env.OMX_TEAM_STATE_ROOT = join(root, "state");
    const failed = await handleTeamWorkerPostToolUseSuccess({
      ...successPayload(),
      tool_response: { exit_code: 1, stderr: "boom" },
    }, root);
    assert.equal(failed.handled, false);
    assert.equal(failed.reason, "nonzero_exit");
  });

  it("records worker-local heartbeat and evidence for successful Bash PostToolUse", async () => {
    const { cwd, stateRoot, teamName, workerName } = await setupWorkerState();

    const result = await handleTeamWorkerPostToolUseSuccess(successPayload(), cwd);

    assert.equal(result.handled, true);
    assert.equal(result.status, "noop");
    assert.equal(result.teamName, teamName);
    assert.equal(result.workerName, workerName);
    assert.equal(result.stateRoot, stateRoot);
    assert.equal(result.operationKinds.length, 0);
    assert.match(result.dedupeKey ?? "", /^posttooluse:ptu-team:worker-2:/);

    const heartbeat = JSON.parse(await readFile(join(stateRoot, "team", teamName, "workers", workerName, "heartbeat.json"), "utf-8"));
    assert.equal(heartbeat.alive, true);
    assert.equal(heartbeat.source, "posttooluse");
    assert.equal(heartbeat.turn_count, 1);
    assert.equal(typeof heartbeat.last_post_tool_use_at, "string");

    const evidence = JSON.parse(await readFile(join(stateRoot, "team", teamName, "workers", workerName, "posttooluse.json"), "utf-8"));
    assert.equal(evidence.last_success.tool_use_id, "tool-1");
    assert.equal(evidence.last_success.command, "echo ok");

    const events = await readFile(join(stateRoot, "team", teamName, "events", "events.ndjson"), "utf-8");
    assert.match(events, /worker_posttooluse_success/);
  });

  it("central native hook dispatch awaits the bridge after normal PostToolUse output", async () => {
    const { cwd, stateRoot, teamName, workerName } = await setupWorkerState();

    const result = await dispatchCodexNativeHook({ ...successPayload(), cwd }, { cwd });

    assert.equal(result.hookEventName, "PostToolUse");
    assert.equal(result.outputJson, null);
    const evidence = JSON.parse(await readFile(join(stateRoot, "team", teamName, "workers", workerName, "posttooluse.json"), "utf-8"));
    assert.equal(evidence.last_success.tool_use_id, "tool-1");
  });
});
