import { Hono } from "hono";
import { execInAiDev } from "../lib/docker";
import { restartAiDev } from "../lib/restart-ai-dev";
import { OpenChamberSettingsPage } from "../views/openchamber";

const DEFAULT_SETTINGS = { showOpenCodeUpdateNotifications: false };

export interface OpenChamberAdminSettings {
  showOpenCodeUpdateNotifications: boolean;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type AiDevCommand = (command: string, timeoutMs: number) => Promise<CommandResult>;

function readSettingsCommand(settingsPath: string): string {
  return `SETTINGS=${JSON.stringify(settingsPath)}; ` +
    `mkdir -p "$(dirname \"$SETTINGS\")" && ` +
    `if [ ! -e "$SETTINGS" ]; then printf '%s\\n' '${JSON.stringify(DEFAULT_SETTINGS)}' > "$SETTINGS"; fi && ` +
    `jq -e -c 'if type == "object" then {showOpenCodeUpdateNotifications: (.showOpenCodeUpdateNotifications // false)} else error("settings must be an object") end' "$SETTINGS"`;
}

function writeSettingsCommand(settingsPath: string, showOpenCodeUpdateNotifications: boolean): string {
  return `SETTINGS=${JSON.stringify(settingsPath)}; ` +
    `mkdir -p "$(dirname \"$SETTINGS\")" && ` +
    `if [ ! -e "$SETTINGS" ]; then printf '%s\\n' '${JSON.stringify(DEFAULT_SETTINGS)}' > "$SETTINGS"; fi && ` +
    `umask 077; TMP="$(mktemp "${settingsPath}.tmp.XXXXXX")" && ` +
    `jq -e --argjson value ${JSON.stringify(showOpenCodeUpdateNotifications)} ` +
    `'if type != "object" then error("settings must be an object") elif has("showOpenCodeUpdateNotifications") and (.showOpenCodeUpdateNotifications | type != "boolean") then error("update notification setting must be boolean") else .showOpenCodeUpdateNotifications = $value end' ` +
    `"$SETTINGS" > "$TMP" || { rm -f "$TMP"; exit 1; }; mv "$TMP" "$SETTINGS"`;
}

function parseSettings(stdout: string): OpenChamberAdminSettings | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>).showOpenCodeUpdateNotifications;
    return typeof value === "boolean" ? { showOpenCodeUpdateNotifications: value } : null;
  } catch {
    return null;
  }
}

function errorMessage(result: CommandResult, fallback: string): string {
  return result.stderr.trim() || fallback;
}

export interface OpenChamberRoutesOptions {
  command?: AiDevCommand;
  settingsPath?: string;
  nativeAgentsMarkerPath?: string;
  opencodeConfigPath?: string;
  env?: Readonly<Record<string, string | undefined>>;
  restart?: typeof restartAiDev;
}

export function createOpenChamberRoutes(options: OpenChamberRoutesOptions = {}) {
  const command = options.command ?? execInAiDev;
  const settingsPath = options.settingsPath ?? "/home/devuser/.config/openchamber/settings.json";
  const markerPath = options.nativeAgentsMarkerPath ?? "/home/devuser/.config/opencode/.native-agents";
  const opencodeConfigPath = options.opencodeConfigPath ?? "/home/devuser/.config/opencode/opencode.json";
  const env = options.env ?? process.env;
  const restart = options.restart ?? restartAiDev;
  const openchamber = new Hono();

  openchamber.get("/api/openchamber/agent-line", async (c) => {
    const explicitNativeAgents = env["NATIVE_AGENTS"];
    if (explicitNativeAgents !== undefined && explicitNativeAgents !== "") {
      return c.json({ line: explicitNativeAgents === "1" ? "native" : "omo", source: "env" });
    }

    const result = await command(
      `MARKER=${JSON.stringify(markerPath)}; CONFIG=${JSON.stringify(opencodeConfigPath)}; ` +
      `if [ -e "$MARKER" ]; then marker=true; else marker=false; fi; ` +
      `jq -e '(.plugin // []) | length == 0' "$CONFIG" >/dev/null && plugin=true || plugin=false; ` +
      `printf '%s %s\\n' "$marker" "$plugin"`,
      10_000,
    );
    if (result.exitCode !== 0) {
      return c.json({ error: errorMessage(result, "Could not inspect native agents configuration") }, 500);
    }
    const [marker, plugin] = result.stdout.trim().split(" ");
    if (marker === "true" && plugin === "true") return c.json({ line: "native", source: "marker" });
    if (marker === "false" && plugin === "false") return c.json({ line: "omo", source: "marker" });
    return c.json({ line: "omo", source: "default" });
  });

  openchamber.post("/api/openchamber/agent-line", async (c) => {
    if (env["NATIVE_AGENTS"] !== undefined && env["NATIVE_AGENTS"] !== "") {
      return c.json({ error: "NATIVE_AGENTS is set in the container environment; the marker cannot override it" }, 409);
    }
    const current = await command(
      `MARKER=${JSON.stringify(markerPath)}; CONFIG=${JSON.stringify(opencodeConfigPath)}; ` +
      `if [ -e "$MARKER" ]; then marker=true; else marker=false; fi; ` +
      `jq -e '(.plugin // []) | length == 0' "$CONFIG" >/dev/null && plugin=true || plugin=false; ` +
      `printf '%s %s\\n' "$marker" "$plugin"`,
      10_000,
    );
    if (current.exitCode !== 0) return c.json({ error: errorMessage(current, "Could not inspect native agents configuration") }, 500);
    const [marker, plugin] = current.stdout.trim().split(" ");
    const previousMarker = marker === "true";
    const currentlyNative = previousMarker && plugin === "true";
    const targetNative = !currentlyNative;
    const writeMarker = (enabled: boolean) => enabled
      ? `umask 077; TMP="$(mktemp ${JSON.stringify(`${markerPath}.tmp.XXXXXX`)})" && printf '%s\\n' 'native agents enabled' > "$TMP" && mv "$TMP" ${JSON.stringify(markerPath)}`
      : `if [ -e ${JSON.stringify(markerPath)} ]; then rm ${JSON.stringify(markerPath)}; else exit 1; fi`;
    const written = await command(writeMarker(targetNative), 10_000);
    if (written.exitCode !== 0) return c.json({ error: errorMessage(written, "Could not update native agents marker") }, 500);

    const restarted = await restart();
    if (restarted.ok === false) {
      const rollback = await command(writeMarker(previousMarker), 10_000);
      const rollbackError = rollback.exitCode === 0 ? "" : `; marker rollback failed: ${errorMessage(rollback, "unknown error")}`;
      return c.json({ error: `ai-dev restart failed: ${restarted.error}${rollbackError}` }, 500);
    }
    return c.json({ ok: true, line: targetNative ? "native" : "omo", source: "marker" });
  });

  openchamber.get("/api/openchamber/settings", async (c) => {
    const result = await command(readSettingsCommand(settingsPath), 10_000);
    if (result.exitCode !== 0) {
      return c.json({ error: errorMessage(result, "Could not read OpenChamber settings") }, 500);
    }

    const settings = parseSettings(result.stdout);
    if (!settings) {
      return c.json({ error: "OpenChamber settings are malformed" }, 500);
    }
    return c.json(settings);
  });

  openchamber.put("/api/openchamber/settings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "Request body must be an object" }, 400);
    }

    const value = (body as Record<string, unknown>).showOpenCodeUpdateNotifications;
    if (typeof value !== "boolean") {
      return c.json({ error: "showOpenCodeUpdateNotifications must be a boolean" }, 400);
    }

    const result = await command(writeSettingsCommand(settingsPath, value), 10_000);
    if (result.exitCode !== 0) {
      return c.json({ error: errorMessage(result, "Could not update OpenChamber settings") }, 500);
    }
    return c.json({ ok: true, showOpenCodeUpdateNotifications: value });
  });

  openchamber.get("/openchamber", (c) => c.html(OpenChamberSettingsPage()));
  return openchamber;
}

export default createOpenChamberRoutes();
