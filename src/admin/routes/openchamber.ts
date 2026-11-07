import { Hono } from "hono";
import { execInAiDev } from "../lib/docker";
import { restartAiDev } from "../lib/restart-ai-dev";
import { deleteEnvVar, readEnvFile, upsertEnvVar } from "../lib/env";
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
  omoConfigPath?: string;
  routingConfigPath?: string;
  env?: Readonly<Record<string, string | undefined>>;
  restart?: typeof restartAiDev;
  readEnv?: () => Record<string, string>;
  writeEnv?: (key: string, value: string) => void;
  deleteEnv?: (key: string) => void;
}

export function createOpenChamberRoutes(options: OpenChamberRoutesOptions = {}) {
  const command = options.command ?? execInAiDev;
  const settingsPath = options.settingsPath ?? "/home/devuser/.config/openchamber/settings.json";
  const markerPath = options.nativeAgentsMarkerPath ?? "/home/devuser/.config/opencode/.native-agents";
  const opencodeConfigPath = options.opencodeConfigPath ?? "/home/devuser/.config/opencode/opencode.json";
  const omoConfigPath = options.omoConfigPath ?? "/home/devuser/.omo/omo.jsonc";
  const routingConfigPath = options.routingConfigPath ?? "/home/devuser/.config/opencode/routing.json";
  const env = options.env ?? process.env;
  const restart = options.restart ?? restartAiDev;
  const readEnv = options.readEnv ?? readEnvFile;
  const writeEnv = options.writeEnv ?? upsertEnvVar;
  const deleteEnv = options.deleteEnv ?? deleteEnvVar;
  const openchamber = new Hono();

  function effectiveOmoEnabled(): string | undefined {
    try {
      const fromFile = readEnv()["OMO_ENABLED"];
      if (fromFile !== undefined) return fromFile;
    } catch {
      // readEnv failure means no registry signal; fall through to container env.
    }
    return env["OMO_ENABLED"];
  }

  // One-way migration is complete when the marker exists AND the effective
  // OMO_ENABLED is "0". Either signal alone is a legacy half-state from the
  // retired bidirectional toggle and must not be reported as migrated.
  function isMigrated(marker: boolean, omoEnabled: string | undefined): boolean {
    return marker === true && omoEnabled === "0";
  }

  async function inspectLine(): Promise<{ marker: boolean; pluginIsEmpty: boolean } | null> {
    const result = await command(
      `MARKER=${JSON.stringify(markerPath)}; CONFIG=${JSON.stringify(opencodeConfigPath)}; ` +
      `if [ -e "$MARKER" ]; then marker=true; else marker=false; fi; ` +
      `jq -e '(.plugin // []) | length == 0' "$CONFIG" >/dev/null && plugin=true || plugin=false; ` +
      `printf '%s %s\\n' "$marker" "$plugin"`,
      10_000,
    );
    if (result.exitCode !== 0) return null;
    const [marker, plugin] = result.stdout.trim().split(" ");
    return { marker: marker === "true", pluginIsEmpty: plugin === "true" };
  }

  openchamber.get("/api/openchamber/agent-line", async (c) => {
    const explicitNativeAgents = env["NATIVE_AGENTS"];
    if (explicitNativeAgents !== undefined && explicitNativeAgents !== "") {
      const omoEnabled = effectiveOmoEnabled();
      const line = explicitNativeAgents === "1" ? "native" : "omo";
      // Container-env pin wins; migration state is still reported so the UI
      // can explain why the button stays locked.
      const inspected = await inspectLine();
      const migrated = inspected !== null && isMigrated(inspected.marker, omoEnabled);
      return c.json({ line, source: "env", migrated, canMigrate: !migrated });
    }

    const inspected = await inspectLine();
    if (inspected === null) {
      return c.json({ error: errorMessage({ exitCode: 1, stdout: "", stderr: "Could not inspect native agents configuration" }, "Could not inspect native agents configuration") }, 500);
    }
    const omoEnabled = effectiveOmoEnabled();
    if (isMigrated(inspected.marker, omoEnabled)) {
      return c.json({ line: "native", source: "migrated", migrated: true, canMigrate: false });
    }
    if (inspected.marker && inspected.pluginIsEmpty) {
      // Legacy half-state from the retired toggle (marker without OMO_ENABLED=0).
      // Report native for compatibility but keep migration available so the
      // operator can complete it to the locked state.
      return c.json({ line: "native", source: "marker", migrated: false, canMigrate: true });
    }
    if (!inspected.marker && !inspected.pluginIsEmpty) {
      return c.json({ line: "omo", source: "marker", migrated: false, canMigrate: true });
    }
    return c.json({ line: "omo", source: "default", migrated: false, canMigrate: true });
  });

  // Retired: the bidirectional marker flip caused native/omo divergence
  // (marker moved but OMO_ENABLED/routing.json did not). Use the one-way
  // migration endpoint instead.
  openchamber.post("/api/openchamber/agent-line", async (c) => {
    return c.json({ error: "Bidirectional switch retired; use POST /api/openchamber/migrate-to-native for the one-way OMO to native migration" }, 410);
  });

  openchamber.post("/api/openchamber/migrate-to-native", async (c) => {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON with {confirm:true}" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body) ||
        (body as Record<string, unknown>).confirm !== true) {
      return c.json({ error: "One-way migration requires {confirm:true}; this cannot be undone" }, 400);
    }

    const inspected = await inspectLine();
    if (inspected === null) {
      return c.json({ error: "Could not inspect native agents configuration" }, 500);
    }
    const previousMarker = inspected.marker;
    let previousOmo: string | undefined;
    try {
      previousOmo = readEnv()["OMO_ENABLED"];
    } catch {
      previousOmo = undefined;
    }
    if (isMigrated(previousMarker, previousOmo ?? env["OMO_ENABLED"])) {
      return c.json({ error: "Already migrated to native; migration cannot be run again" }, 409);
    }

    // 1) Ensure the marker exists (atomic write).
    if (!previousMarker) {
      const created = await command(
        `umask 077; TMP="$(mktemp ${JSON.stringify(`${markerPath}.tmp.XXXXXX`)})" && printf '%s\\n' 'native agents enabled' > "$TMP" && mv "$TMP" ${JSON.stringify(markerPath)}`,
        10_000,
      );
      if (created.exitCode !== 0) {
        return c.json({ error: errorMessage(created, "Could not create native agents marker") }, 500);
      }
    }

    // 2) Lock the single source of truth: OMO_ENABLED=0 in the registry file.
    // The entrypoint derives the native line from NATIVE_AGENTS=1 || OMO_ENABLED=0,
    // and Admin reads routing.json only when OMO_ENABLED=0 is effective.
    try {
      writeEnv("OMO_ENABLED", "0");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!previousMarker) await command(`rm -f ${JSON.stringify(markerPath)}`, 10_000);
      return c.json({ error: `Could not persist OMO_ENABLED=0: ${message}` }, 500);
    }

    // 3) Best-effort carry-over: seed routing.json chains for general/plan from
    // omo.jsonc when routing has no chain yet. Never fails the migration;
    // the entrypoint seeds heads from routing.json on the next boot.
    await command(
      `ROUTING=${JSON.stringify(routingConfigPath)}; OMO=${JSON.stringify(omoConfigPath)}; ` +
      `mkdir -p "$(dirname "$ROUTING")"; ` +
      `if [ ! -f "$ROUTING" ]; then printf '%s' '{"version":1,"chains":{}}' > "$ROUTING"; fi; ` +
      `if [ -f "$OMO" ]; then ` +
      `jq -s '.[0] as $r | .[1] as $o | reduce ["general","plan"][] as $a ($r; if ((.chains[$a].chain // null) == null and (($o.agents[$a].model // null) | type) == "string") then .chains[$a] = {chain: [{model: $o.agents[$a].model} + (if (($o.agents[$a].variant // null) | type) == "string" then {variant: $o.agents[$a].variant} else {} end)]} else . end)' "$ROUTING" "$OMO" > "$ROUTING.tmp" 2>/dev/null && mv "$ROUTING.tmp" "$ROUTING" || rm -f "$ROUTING.tmp"; fi`,
      10_000,
    );

    // 4) Recreate ai-dev so the entrypoint regenerates plugin-free opencode.json,
    // deploys native agents, and prunes OMO ghosts in one boot.
    const restarted = await restart();
    if (restarted.ok === false) {
      if (!previousMarker) await command(`rm -f ${JSON.stringify(markerPath)}`, 10_000);
      try {
        if (previousOmo === undefined) deleteEnv("OMO_ENABLED");
        else writeEnv("OMO_ENABLED", previousOmo);
      } catch {
        // Report the restart failure; env rollback best-effort only.
      }
      return c.json({ error: `ai-dev restart failed: ${restarted.error}` }, 500);
    }
    return c.json({ ok: true, line: "native", migrated: true, source: "migrated" });
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
