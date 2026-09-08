/**
 * Docker compose exec orchestration helper.
 * Runs commands inside the ai-dev container via the Docker socket.
 */

const DOCKER_SOCKET = "/var/run/docker.sock";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Get the current container's ID from /etc/hostname (set by Docker).
 * Used to inspect the admin container's own image metadata.
 */
export async function getSelfContainerRef(): Promise<string> {
  try {
    const id = await Bun.file("/etc/hostname").text();
    const trimmed = id.trim();
    if (trimmed) return trimmed;
  } catch {}
  return "ai-engkit-admin";
}

/**
 * Get the host-side source for one of this container's bind mounts.
 * Docker daemon paths must be used when a helper container controls DooD.
 */
export async function getSelfBindSource(destination: string): Promise<string | null> {
  const ref = await getSelfContainerRef();
  const result = await dockerCommand(
    `inspect --format='{{json .Mounts}}' ${ref}`,
    5_000,
  );
  if (result.exitCode !== 0 || !result.stdout) return null;

  try {
    const mounts = JSON.parse(result.stdout) as Array<{ Type?: string; Source?: string; Destination?: string }>;
    const mount = mounts.find((item) => item.Type === "bind" && item.Destination === destination);
    return mount?.Source || null;
  } catch {
    return null;
  }
}

/**
 * Get this container's own name (e.g. "ai-engkit-admin" or "ai-engkit-admin-dev").
 * Used to derive the sibling dev container name.
 */
async function getOwnContainerName(): Promise<string> {
  const ref = await getSelfContainerRef();
  const result = await runCommand(
    ["docker", "inspect", "--format={{.Name}}", ref],
    5_000,
  );
  if (result.exitCode === 0 && result.stdout.trim()) {
    // Docker name starts with "/"
    return result.stdout.trim().replace(/^\//, "");
  }
  return "ai-engkit-admin";
}

/**
 * Derive the dev container name from this admin container's name.
 * Convention: ai-engkit-admin → ai-engkit, ai-engkit-admin-dev → ai-engkit-dev
 */
export async function getSiblingDevContainerName(): Promise<string> {
  const self = await getOwnContainerName();
  // Strip "-admin-dev" or "-admin" suffix to get the dev container name
  // ai-engkit-admin-dev → ai-engkit-dev,  ai-engkit-admin → ai-engkit
  if (self.endsWith("-admin-dev")) return self.slice(0, -"-admin-dev".length) + "-dev";
  if (self.endsWith("-admin")) return self.slice(0, -"-admin".length);
  return self;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  readonly preserveOutput?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly dockerBinary?: string;
}

function dockerArgs(args: string[], options: ExecOptions): string[] {
  if (args[0] !== "docker" || options.dockerBinary === undefined) return args;
  return [options.dockerBinary, ...args.slice(1)];
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Find the ai-dev container via its compose service label, scoped to the
 * same compose project as this admin container. Labels survive container_name
 * overrides (CI renames ai-dev to "ci-test"); the derived name does not.
 */
async function getAiDevContainerByService(): Promise<string> {
  const selfRef = await getSelfContainerRef();
  const projectResult = await dockerCommand(
    `inspect --format='{{index .Config.Labels "com.docker.compose.project"}}' ${selfRef}`,
    5_000,
  );
  const project = projectResult.exitCode === 0 ? projectResult.stdout.trim() : "";
  const filters = ["status=running", "label=com.docker.compose.service=ai-dev"];
  if (project) filters.push(`label=com.docker.compose.project=${project}`);
  const args = ["docker", "ps", "--format", "{{.ID}}"];
  for (const filter of filters) args.push("--filter", filter);
  const result = await runCommand(args, 10_000);
  if (result.exitCode === 0 && result.stdout.trim()) {
    return result.stdout.trim().split("\n")[0];
  }
  return "";
}

export async function getAiDevContainerRef(): Promise<string> {
  const byService = await getAiDevContainerByService();
  if (byService) return byService;

  const devName = await getSiblingDevContainerName();
  const result = await runCommand(
    ["docker", "ps", "--filter", "status=running", "--filter", `name=^/${devName}$`, "--format", "{{.ID}}"],
    10_000,
  );
  if (result.exitCode === 0 && result.stdout.trim()) {
    return result.stdout.trim().split("\n")[0];
  }
  return devName;
}

export async function execInAiDev(
  command: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const ref = await getAiDevContainerRef();
  const args = ["docker", "exec", ref, "sh", "-c", command];
  return runCommand(args, timeoutMs, options.preserveOutput === true);
}

/**
 * Valid Docker Compose project names: lowercase letters, digits, dashes, and
 * underscores, starting with a letter or digit. Anything else (whitespace,
 * quotes, shell metacharacters, empty) is rejected so a project value can
 * never inject extra shell commands when interpolated by legacy callers.
 */
const COMPOSE_PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidComposeProjectName(name: string): boolean {
  return COMPOSE_PROJECT_NAME.test(name);
}

function assertComposeProjectName(project: string): void {
  if (!isValidComposeProjectName(project)) {
    throw new Error(
      `Invalid compose project name ${JSON.stringify(project)}: must match ${String(COMPOSE_PROJECT_NAME)}`,
    );
  }
}

/**
 * Split a docker/compose subcommand into argv tokens, honoring single and
 * double quotes (quotes are stripped; unbalanced quotes throw instead of
 * silently corrupting the command). Also reports whether the subcommand uses
 * shell operators (pipes, redirects, ||, &&, $, backticks, ...) outside of
 * quotes, so callers that still rely on them keep working via an explicit
 * shell fallback instead of being misparsed as literal docker arguments.
 */
function parseSubcommand(subcommand: string): { readonly args: string[]; readonly usesShell: boolean } {
  const args: string[] = [];
  let current = "";
  let hasToken = false;
  let usesShell = false;
  let quote: "'" | '"' | null = null;
  const push = (): void => {
    if (hasToken) {
      args.push(current);
      current = "";
      hasToken = false;
    }
  };
  let i = 0;
  while (i < subcommand.length) {
    const ch = subcommand[i];
    if (quote === "'") {
      // Single-quoted spans are literal (no expansion), matching sh semantics.
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        i++;
        continue;
      }
      if (ch === "\\" && i + 1 < subcommand.length) {
        current += subcommand[i + 1];
        i += 2;
        continue;
      }
      // A $ or backtick inside double quotes would expand under a shell, so a
      // subcommand containing one must keep shell semantics to stay compatible.
      if (ch === "$" || ch === "`") usesShell = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < subcommand.length) {
      current += subcommand[i + 1];
      hasToken = true;
      i += 2;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      push();
      i++;
      continue;
    }
    if (ch === "|" || ch === "&" || ch === ";" || ch === "<" || ch === ">" || ch === "`" || ch === "$" || ch === "(" || ch === ")") {
      usesShell = true;
    }
    current += ch;
    hasToken = true;
    i++;
  }
  if (quote !== null) {
    throw new Error(`Unbalanced quote in docker subcommand: ${JSON.stringify(subcommand)}`);
  }
  push();
  return { args, usesShell };
}

/** Fail before execution when a `-p` project value is missing or invalid. */
function assertProjectFlag(args: string[], subcommand: string): void {
  const flagIndex = args.indexOf("-p");
  if (flagIndex === -1) return;
  const project = args[flagIndex + 1];
  if (project === undefined) {
    throw new Error(`Refusing to run docker command with a missing -p project value: ${JSON.stringify(subcommand)}`);
  }
  assertComposeProjectName(project);
}

/**
 * Detect the docker compose project name from this admin container's own
 * label. Fails closed: an inspect failure, a blank label, or a label that is
 * not a valid project name throws instead of silently targeting production
 * ("ai-engkit") during a socket/inspect outage.
 */
export async function getComposeProject(options: ExecOptions = {}): Promise<string> {
  const selfRef = await getSelfContainerRef();
  const result = await runCommand(
    dockerArgs(["docker", "inspect", "--format={{index .Config.Labels \"com.docker.compose.project\"}}", selfRef], options),
    5_000,
    false,
    options.env,
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.stdout || `exit code ${result.exitCode}`;
    throw new Error(`Failed to detect compose project: docker inspect of ${JSON.stringify(selfRef)} failed (${detail})`);
  }
  const project = result.stdout.trim();
  if (!project) {
    throw new Error(
      "Failed to detect compose project: com.docker.compose.project label is blank; refusing to guess a fallback",
    );
  }
  assertComposeProjectName(project);
  return project;
}

/**
 * Run a raw docker compose command against the compose file.
 * The subcommand is tokenized quote-aware (never via a shell); a trailing
 * `2>&1` is dropped as a no-op because runCommand already captures stderr
 * separately. Any other shell operator or an invalid `-p` project value
 * throws before anything executes.
 */
export async function composeCommand(
  subcommand: string,
  timeoutMs: number = 120_000,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const { args, usesShell } = parseSubcommand(subcommand);
  if (args.length === 0) {
    throw new Error("Refusing to run an empty compose subcommand");
  }
  const filtered = args.length > 0 && args[args.length - 1] === "2>&1" ? args.slice(0, -1) : args;
  if (usesShell && filtered.length === args.length) {
    throw new Error(
      `Refusing to run compose subcommand with shell operators (pipe/redirect/||/&& are not supported): ${JSON.stringify(subcommand)}`,
    );
  }
  assertProjectFlag(filtered, subcommand);
  return runCommand(dockerArgs(["docker", "compose", ...filtered], options), timeoutMs, false, options.env);
}

/**
 * Run a raw docker command. Subcommands without shell operators execute
 * directly as argv (no shell), so project-derived and container-ref values
 * are passed literally and cannot inject extra commands. Subcommands that
 * genuinely pipe (jq/cut) or use `||` fallbacks keep explicit `sh -c`
 * semantics; project values interpolated there are allowlisted by
 * isValidComposeProjectName (enforced at getComposeProject and via the -p
 * check below), so they cannot inject either.
 */
export async function dockerCommand(
  subcommand: string,
  timeoutMs: number = 120_000,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const { args, usesShell } = parseSubcommand(subcommand);
  if (args.length === 0) {
    throw new Error("Refusing to run an empty docker subcommand");
  }
  assertProjectFlag(args, subcommand);
  const dockerBinary = options.dockerBinary ?? "docker";
  if (usesShell) {
    return runCommand(["sh", "-c", `${shellQuote(dockerBinary)} ${subcommand}`], timeoutMs, false, options.env);
  }
  return runCommand(dockerArgs(["docker", ...args], options), timeoutMs, false, options.env);
}

/**
 * Check if the ai-dev container is running.
 */
export async function isAiDevRunning(): Promise<boolean> {
  const devName = await getSiblingDevContainerName();
  const result = await runCommand(
    ["docker", "ps", "--filter", "status=running", "--filter", `name=^/${devName}$`, "--format", "{{.Names}}"],
    10_000,
  );
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

/**
 * Get container uptime in seconds.
 */
export async function getAiDevUptime(): Promise<number | null> {
  const ref = await getAiDevContainerRef();
  const result = await runCommand(
    ["docker", "inspect", "--format={{.State.StartedAt}}", ref],
    10_000,
  );
  if (result.exitCode !== 0 || !result.stdout.trim()) return null;
  const startedAt = new Date(result.stdout.trim());
  return Math.floor((Date.now() - startedAt.getTime()) / 1000);
}

/**
 * Low-level command runner with timeout enforcement.
 * Uses explicit args array to avoid shell quoting issues.
 */
async function runCommand(
  args: string[],
  timeoutMs: number,
  preserveOutput = false,
  envOverrides: Readonly<Record<string, string | undefined>> = {},
): Promise<ExecResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const process = Bun.spawn(args, {
      signal: controller.signal,
      env: { ...Bun.env, ...envOverrides, DOCKER_HOST: "unix://" + DOCKER_SOCKET },
    });

    const stdout = await new Response(process.stdout).text();
    const stderr = await new Response(process.stderr).text();
    const exitCode = await process.exited;

    return { stdout: preserveOutput ? stdout : stdout.trim(), stderr: stderr.trim(), exitCode };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return { stdout: "", stderr: `Command timed out after ${timeoutMs}ms`, exitCode: -1 };
    }
    return { stdout: "", stderr: String(err), exitCode: -1 };
  } finally {
    clearTimeout(timer);
  }
}

export { runCommand };
