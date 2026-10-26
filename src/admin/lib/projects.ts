import { execInAiDev } from "./docker";
import {
  isValidProjectName,
  mergeDisabledProject,
  mergeOpenChamberProject,
  projectId,
  readDisabledProjects,
  type SettingsCommand,
} from "./openchamber-projects";
import { checkFeature, collectProjectOverviews, listProjects } from "./projects-overview";

export type ProjectCommand = SettingsCommand;

export const PROJECT_FEATURES = ["knowledge", "maintenance", "openspec", "superpowers", "security-audit"] as const;
export type ProjectFeature = (typeof PROJECT_FEATURES)[number];

export interface ProjectLibOptions {
  command?: ProjectCommand;
  settingsPath?: string;
  disabledPath?: string;
  workspaceRoot?: string;
  /** Called after a sync applied add/remove changes (no-op by default). */
  onSyncDone?: () => void;
}

export type ProjectActionResult =
  | { ok: true; messages?: string[]; output?: string }
  | { ok: false; error: string; partial?: boolean; status?: number; messages?: string[] };

export const DEFAULT_WORKSPACE_ROOT = "/home/devuser/workspace";
export const DEFAULT_OPENCHAMBER_SETTINGS = "/home/devuser/.config/openchamber/settings.json";
export const DEFAULT_OPENCHAMBER_DISABLED = "/home/devuser/.config/openchamber/disabled-projects.json";

const projectDir = (workspaceRoot: string, name: string) => JSON.stringify(`${workspaceRoot}/${name}`);

function resolveOptions(options: ProjectLibOptions): Required<ProjectLibOptions> {
  return {
    command: options.command ?? execInAiDev,
    settingsPath: options.settingsPath ?? DEFAULT_OPENCHAMBER_SETTINGS,
    disabledPath: options.disabledPath ?? DEFAULT_OPENCHAMBER_DISABLED,
    workspaceRoot: options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    onSyncDone: options.onSyncDone ?? (() => {}),
  };
}

async function registerWithOpenChamber(
  command: ProjectCommand,
  settingsPath: string,
  workspaceRoot: string,
  name: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const fullPath = `${workspaceRoot}/${name}`;
  const registration = await mergeOpenChamberProject(command, settingsPath, {
    kind: "add",
    id: projectId(fullPath),
    path: fullPath,
    now: Date.now(),
  });
  return registration;
}

/** Create a project: clone a remote (git_init defaults to true with a remote) or git init, then register. */
export async function createProject(
  name: string,
  payload: { gitInit?: boolean; gitRemote?: string },
  options: ProjectLibOptions = {},
): Promise<ProjectActionResult> {
  const { command, settingsPath, disabledPath, workspaceRoot } = resolveOptions(options);
  const gitInit = payload.gitInit ?? (payload.gitRemote !== undefined && payload.gitRemote !== "");
  const remote = payload.gitRemote?.trim();

  if (gitInit && remote) {
    const cloneResult = await command(
      `git clone --depth 1 ${JSON.stringify(remote)} ${projectDir(workspaceRoot, name)} 2>&1`,
      120_000,
    );
    if (cloneResult.exitCode !== 0 && cloneResult.exitCode !== -1) {
      const msg = cloneResult.stderr || cloneResult.stdout || "clone failed";
      return { ok: false, error: `Clone failed. Make sure the URL is correct and git auth is configured (see GitHub/GitLab Auth page). Details: ${msg}` };
    }
    await command(
      `cd ${projectDir(workspaceRoot, name)} && ` +
      `grep -qs '^\\.omo/' .gitignore 2>/dev/null || ` +
      `printf '\\n# AI-EngKit system directories\\n.omo/\\n.playwright-mcp/\\n.codegraph/\\n.sisyphus/\\n.tmp/\\n.env\\nnode_modules/\\nbackups/\\n' >> .gitignore`,
      10_000,
    );
  } else if (gitInit) {
    const createResult = await command(`mkdir -p ${projectDir(workspaceRoot, name)}`, 15_000);
    if (createResult.exitCode !== 0) {
      return { ok: false, error: createResult.stderr || "Failed to create directory" };
    }
    const initResult = await command(
      `cd ${projectDir(workspaceRoot, name)} && git init 2>&1`, 10_000,
    );
    if (initResult.exitCode !== 0 && initResult.exitCode !== -1) {
      return { ok: false, error: `git init failed: ${initResult.stderr || initResult.stdout}` };
    }
    await command(
      `cd ${projectDir(workspaceRoot, name)} && ` +
      `printf '%s\\n' '' '# AI-EngKit system directories' '.omo/' '.playwright-mcp/' '.codegraph/' '.sisyphus/' '.tmp/' '.env' 'node_modules/' 'backups/' > .gitignore`,
      10_000,
    );
    await command(
      `cd ${projectDir(workspaceRoot, name)} && git add -A && git commit -m "Initial commit" 2>/dev/null || true`,
      10_000,
    );
  } else {
    const createResult = await command(`mkdir -p ${projectDir(workspaceRoot, name)}`, 15_000);
    if (createResult.exitCode !== 0) {
      return { ok: false, error: createResult.stderr || "Failed to create directory" };
    }
  }

  // Recreating a project clears any previous disabled state so the disabled
  // list never masks a project the user just created.
  const reenabled = await mergeDisabledProject(command, disabledPath, name, "enable");
  if ("error" in reenabled) {
    return { ok: false, error: `Project created, but its disabled state could not be cleared: ${reenabled.error}` };
  }

  // Register in OpenChamber so it appears automatically without manual "Add project".
  const registration = await registerWithOpenChamber(command, settingsPath, workspaceRoot, name);
  if ("error" in registration) {
    return { ok: false, error: `Project created, but OpenChamber registration failed: ${registration.error}` };
  }

  return { ok: true };
}

/** Set, replace, or remove the origin remote; bootstrap a fresh repo with a shallow fetch and checkout. */
export async function setProjectRemote(
  name: string,
  remote: string,
  options: ProjectLibOptions = {},
): Promise<ProjectActionResult> {
  const { command, workspaceRoot } = resolveOptions(options);
  const base = `cd ${projectDir(workspaceRoot, name)}`;
  const url = remote?.trim();

  if (!url) {
    await command(`${base} && git remote remove origin 2>/dev/null || true`, 10_000);
    return { ok: true };
  }

  // Auto-init if not yet a git repo
  await command(`${base} && git init 2>/dev/null || true`, 10_000);

  const hasRemote = await command(
    `${base} && git remote get-url origin 2>/dev/null || echo "no-remote"`, 10_000,
  );
  const isNewRemote = hasRemote.stdout.trim() === "no-remote";
  const setCmd = isNewRemote
    ? `${base} && git remote add origin ${JSON.stringify(url)}`
    : `${base} && git remote set-url origin ${JSON.stringify(url)}`;

  const setResult = await command(setCmd, 10_000);
  if (setResult.exitCode !== 0 && setResult.exitCode !== -1) {
    return { ok: false, error: setResult.stderr || "Failed to set git remote" };
  }

  const hasCommits = await command(
    `${base} && git cat-file -t HEAD 2>/dev/null || true`, 5_000,
  );
  if (hasCommits.stdout.trim() !== "commit") {
    const fetch = await command(
      `${base} && git fetch origin --depth 1 2>&1`, 120_000,
    );
    if (fetch.exitCode !== 0 && fetch.exitCode !== -1) {
      return { ok: false, error: `Remote set, but fetch failed: ${fetch.stderr || fetch.stdout || "unknown"}`, partial: true };
    }
    const checkout = await command(
      `${base} && (git checkout -f --track origin/main 2>/dev/null || git checkout -f --track origin/master 2>/dev/null || true)`,
      30_000,
    );
    if (checkout.exitCode !== 0 && checkout.exitCode !== -1) {
      const msg = checkout.stderr || checkout.stdout || "checkout failed";
      return { ok: false, error: `Remote set and fetched, but checkout failed: ${msg}`, partial: true };
    }
  }

  return { ok: true };
}

/** Unmark the disabled state and re-register the project with OpenChamber. */
export async function enableProject(name: string, options: ProjectLibOptions = {}): Promise<ProjectActionResult> {
  const { command, settingsPath, disabledPath, workspaceRoot } = resolveOptions(options);

  const exists = await command(`test -d ${projectDir(workspaceRoot, name)} && echo yes`, 5_000);
  if (exists.stdout.trim() !== "yes") return { ok: false, error: "Project not found", status: 404 };

  const unmarked = await mergeDisabledProject(command, disabledPath, name, "enable");
  if ("error" in unmarked) {
    return { ok: false, error: `Could not enable project: ${unmarked.error}` };
  }

  const registration = await registerWithOpenChamber(command, settingsPath, workspaceRoot, name);
  if ("error" in registration) {
    // The project is enabled but unregistered; the next reconcile pass
    // re-adds it automatically, so no rollback is needed.
    return { ok: false, error: `Project enabled, but OpenChamber registration failed: ${registration.error}`, partial: true };
  }
  return { ok: true };
}

/** Mark the project disabled and unregister it from OpenChamber, rolling back on failure. */
export async function disableProject(name: string, options: ProjectLibOptions = {}): Promise<ProjectActionResult> {
  const { command, settingsPath, disabledPath, workspaceRoot } = resolveOptions(options);

  const exists = await command(`test -d ${projectDir(workspaceRoot, name)} && echo yes`, 5_000);
  if (exists.stdout.trim() !== "yes") return { ok: false, error: "Project not found", status: 404 };

  const marked = await mergeDisabledProject(command, disabledPath, name, "disable");
  if ("error" in marked) {
    return { ok: false, error: `Could not disable project: ${marked.error}` };
  }

  const fullPath = `${workspaceRoot}/${name}`;
  const removed = await mergeOpenChamberProject(command, settingsPath, {
    kind: "remove",
    id: projectId(fullPath),
    path: fullPath,
  });
  if ("error" in removed) {
    // Roll the disabled mark back so the state file stays consistent with
    // OpenChamber: the project remains visible and a retry is safe.
    await mergeDisabledProject(command, disabledPath, name, "enable");
    return { ok: false, error: `Could not unregister project from OpenChamber: ${removed.error}`, partial: true };
  }
  return { ok: true };
}

/**
 * Permanently delete a project: unregister from OpenChamber, remove disabled
 * state, delete the per-project OpenChamber state file, and rm -rf the
 * workspace directory. This action is irreversible.
 *
 * Ordering: unregister BEFORE rm so a failed delete leaves the project
 * discoverable (re-registered on next sync) rather than becoming a ghost.
 */
export async function deleteProject(
  name: string,
  confirmationName: string,
  options: ProjectLibOptions = {},
): Promise<ProjectActionResult> {
  if (confirmationName !== name) {
    return { ok: false, error: "Project name confirmation does not match", status: 400 };
  }

  const { command, settingsPath, disabledPath, workspaceRoot, onSyncDone } = resolveOptions(options);

  const exists = await command(`test -d ${projectDir(workspaceRoot, name)} && echo yes`, 5_000);
  if (exists.stdout.trim() !== "yes") return { ok: false, error: "Project not found", status: 404 };

  const fullPath = `${workspaceRoot}/${name}`;

  // 1. Unregister from OpenChamber settings.json
  const removed = await mergeOpenChamberProject(command, settingsPath, {
    kind: "remove",
    id: projectId(fullPath),
    path: fullPath,
  });
  if ("error" in removed) {
    return { ok: false, error: `Could not unregister project from OpenChamber: ${removed.error}` };
  }

  // 2. Remove from disabled-projects.json (ignore failure — project may not be disabled)
  const disabled = await readDisabledProjects(command, disabledPath);
  if (disabled.includes(name)) {
    await mergeDisabledProject(command, disabledPath, name, "enable");
  }

  // 3. Delete per-project OpenChamber state file (best-effort)
  const stateFile = `${workspaceRoot}/${name}`;
  const ocId = projectId(fullPath);
  const ocDir = `${workspaceRoot}/../.config/openchamber/projects`;
  await command(`rm -f "${ocDir}/${ocId}.json" 2>/dev/null || true`, 5_000);

  // 4. Remove the workspace directory
  const rmResult = await command(`rm -rf ${projectDir(workspaceRoot, name)}`, 30_000);
  if (rmResult.exitCode !== 0 && rmResult.exitCode !== -1) {
    return { ok: false, error: `Project unregistered, but directory removal failed: ${rmResult.stderr || "unknown error"}`, partial: true };
  }

  onSyncDone();
  return { ok: true };
}

/** Enable one of the whitelisted skill scaffolds (knowledge, maintenance, openspec). */
export async function enableProjectFeature(
  name: string,
  feature: string,
  options: ProjectLibOptions = {},
): Promise<ProjectActionResult> {
  const { command, workspaceRoot } = resolveOptions(options);
  const PROJECT_ROOT = projectDir(workspaceRoot, name);
  let cmd = "";
  switch (feature) {
    case "knowledge":
      cmd = `bash ~/.config/opencode/skills/enable-project-knowledge/bootstrap.sh ${PROJECT_ROOT}`;
      break;
    case "maintenance":
      cmd = `bash ~/.config/opencode/skills/enable-finalize-maintenance/bootstrap.sh ${PROJECT_ROOT}`;
      break;
    case "openspec":
      cmd = `openspec init --tools opencode --force ${PROJECT_ROOT}`;
      break;
    case "superpowers":
      cmd = `mkdir -p ${PROJECT_ROOT}/.opencode/skills && for d in /opt/opencode/baked-plugins/superpowers/skills/*/; do ln -sfn "$d" "${PROJECT_ROOT}/.opencode/skills/$(basename "$d")"; done && mkdir -p ${PROJECT_ROOT}/.opencode/superpowers`;
      break;
    case "security-audit":
      cmd = `bash ~/.config/opencode/skills/enable-security-audit/bootstrap.sh ${PROJECT_ROOT}`;
      break;
    default:
      return { ok: false, error: `Unknown feature '${feature}'. Valid: ${PROJECT_FEATURES.join(", ")}` };
  }

  const result = await command(cmd, 30_000);
  if (result.exitCode !== 0 && result.exitCode !== -1) {
    return { ok: false, error: result.stderr || "Feature enable failed" };
  }
  return { ok: true, output: result.stdout };
}

/** Disable a project feature, removing its scaffolding. */
export async function disableProjectFeature(
  name: string,
  feature: string,
  options: ProjectLibOptions = {},
): Promise<ProjectActionResult> {
  const { command, workspaceRoot } = resolveOptions(options);
  const PROJECT_ROOT = projectDir(workspaceRoot, name);
  let cmd = "";
  switch (feature) {
    case "superpowers":
      cmd = `rm -rf ${PROJECT_ROOT}/.opencode/superpowers && find ${PROJECT_ROOT}/.opencode/skills -maxdepth 1 -type l -exec sh -c 'readlink "$1" | grep -q baked-plugins/superpowers && rm "$1"' _ {} \\;`;
      break;
    case "security-audit":
      // True deletion: the tree is 100% upstream-owned and rebuildable via
      // bootstrap.sh. Remove the skill tree, then strip the routing-note
      // segment from AGENTS.md; delete AGENTS.md when the note was its only
      // content. (Do NOT copy the knowledge/maintenance no-op — those guard
      // user content, while this tree is regenerable.)
      cmd = `rm -rf ${PROJECT_ROOT}/.opencode/skills/security-audit && `
        + `if [ -f ${PROJECT_ROOT}/AGENTS.md ]; then `
        + `awk 'BEGIN{p=1} /<!-- security-audit-routing -->/{p=0;next} /<!-- \\/security-audit-routing -->/{if(p==0){p=1;next}} p' ${PROJECT_ROOT}/AGENTS.md > ${PROJECT_ROOT}/AGENTS.md.tmp && `
        + `mv ${PROJECT_ROOT}/AGENTS.md.tmp ${PROJECT_ROOT}/AGENTS.md; `
        + `if [ ! -s ${PROJECT_ROOT}/AGENTS.md ] || ! grep -q '[^[:space:]]' ${PROJECT_ROOT}/AGENTS.md; then rm -f ${PROJECT_ROOT}/AGENTS.md; fi; `
        + `fi`;
      break;
    case "knowledge":
    case "maintenance":
    case "openspec":
      return { ok: true };
    default:
      return { ok: false, error: `Unknown feature '${feature}'. Valid: ${PROJECT_FEATURES.join(", ")}` };
  }

  const result = await command(cmd, 30_000);
  if (result.exitCode !== 0 && result.exitCode !== -1) {
    return { ok: false, error: result.stderr || "Feature disable failed" };
  }
  return { ok: true, output: result.stdout };
}

/** Reconcile workspace directories with OpenChamber registration from add/remove name arrays. */
export async function syncProjects(
  add: string[],
  remove: string[],
  options: ProjectLibOptions = {},
): Promise<ProjectActionResult> {
  const { command, settingsPath, workspaceRoot, onSyncDone } = resolveOptions(options);

  const messages: string[] = [];
  const failures: string[] = [];
  for (const name of add) {
    const fullPath = `${workspaceRoot}/${name}`;
    const merged = await mergeOpenChamberProject(command, settingsPath, {
      kind: "add",
      id: projectId(fullPath),
      path: fullPath,
      now: Date.now(),
    });
    if ("error" in merged) failures.push(`Failed to add ${name}: ${merged.error}`);
    else messages.push(`Added ${name} to OpenChamber`);
  }
  for (const name of remove) {
    const fullPath = `${workspaceRoot}/${name}`;
    const merged = await mergeOpenChamberProject(command, settingsPath, {
      kind: "remove",
      id: projectId(fullPath),
      path: fullPath,
    });
    if ("error" in merged) failures.push(`Failed to remove ${name}: ${merged.error}`);
    else messages.push(`Removed ${name} from OpenChamber`);
  }

  // Tool status (codegraph index, leanCTX facts) can change with the project
  // set; drop cached probes whenever a sync actually changed something.
  if (add.length > 0 || remove.length > 0) onSyncDone();

  if (failures.length > 0) {
    return { ok: false, error: failures.join("; "), messages };
  }
  return { ok: true, messages };
}

export { checkFeature, collectProjectOverviews, isValidProjectName, listProjects };
