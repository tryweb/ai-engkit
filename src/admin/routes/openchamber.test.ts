import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restartAiDev } from "../lib/restart-ai-dev";
import { createOpenChamberRoutes, type AiDevCommand } from "./openchamber";

function command(result: { exitCode: number; stdout?: string; stderr?: string }): AiDevCommand {
  return async () => ({ stdout: "", stderr: "", ...result });
}

async function shellCommand(source: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(["sh", "-c", source], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("OpenChamber settings routes", () => {
  test("reads the supported update notification setting", async () => {
    const app = createOpenChamberRoutes({ command: command({ exitCode: 0, stdout: '{"showOpenCodeUpdateNotifications":true}' }) });
    const response = await app.request("http://localhost/api/openchamber/settings");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ showOpenCodeUpdateNotifications: true });
  });

  test("rejects unsupported settings payloads", async () => {
    const app = createOpenChamberRoutes({ command: command({ exitCode: 0 }) });
    const response = await app.request("http://localhost/api/openchamber/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "zh-TW" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "showOpenCodeUpdateNotifications must be a boolean" });
  });

  test("writes only the supported boolean setting", async () => {
    let invoked = "";
    const app = createOpenChamberRoutes({ command: async (source) => {
      invoked = source;
      return { exitCode: 0, stdout: "", stderr: "" };
    } });
    const response = await app.request("http://localhost/api/openchamber/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ showOpenCodeUpdateNotifications: true }),
    });

    expect(response.status).toBe(200);
    expect(invoked).toContain(".showOpenCodeUpdateNotifications = $value");
    expect(invoked).toContain("--argjson value true");
    expect(invoked).toContain("mktemp");
  });

  test("reports malformed settings without overwriting them", async () => {
    const app = createOpenChamberRoutes({ command: command({ exitCode: 0, stdout: "not-json" }) });
    const response = await app.request("http://localhost/api/openchamber/settings");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "OpenChamber settings are malformed" });
  });

  test("initializes a missing settings file with the default value", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openchamber-settings-"));
    const settingsPath = join(directory, "settings.json");
    const app = createOpenChamberRoutes({ command: shellCommand, settingsPath });

    try {
      const response = await app.request("http://localhost/api/openchamber/settings");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ showOpenCodeUpdateNotifications: false });
      expect(await readFile(settingsPath, "utf8")).toContain('"showOpenCodeUpdateNotifications":false');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not overwrite an invalid existing notification setting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openchamber-settings-"));
    const settingsPath = join(directory, "settings.json");
    await writeFile(settingsPath, '{"showOpenCodeUpdateNotifications":"yes"}\n');
    const app = createOpenChamberRoutes({ command: shellCommand, settingsPath });

    try {
      const response = await app.request("http://localhost/api/openchamber/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ showOpenCodeUpdateNotifications: true }),
      });
      expect(response.status).toBe(500);
      expect(await readFile(settingsPath, "utf8")).toBe('{"showOpenCodeUpdateNotifications":"yes"}\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("OpenChamber agent line routes", () => {
  async function fixture(plugin: readonly string[], marker: boolean) {
    const directory = await mkdtemp(join(tmpdir(), "openchamber-agent-line-"));
    const markerPath = join(directory, ".native-agents");
    const configPath = join(directory, "opencode.json");
    await writeFile(configPath, JSON.stringify({ plugin }));
    if (marker) await writeFile(markerPath, "native agents enabled\n");
    return {
      markerPath,
      configPath,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  }

  test("reports native only when marker and empty plugin config agree", async () => {
    const f = await fixture([], true);
    try {
      const app = createOpenChamberRoutes({ command: async (source) => shellCommand(source), nativeAgentsMarkerPath: f.markerPath, opencodeConfigPath: f.configPath, env: {} });
      const response = await app.request("http://localhost/api/openchamber/agent-line");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ line: "native", source: "marker" });
    } finally {
      await f.cleanup();
    }
  });

  test("reports OMO when marker and plugin config agree", async () => {
    const f = await fixture(["oh-my-openagent"], false);
    try {
      const app = createOpenChamberRoutes({ command: async (source) => shellCommand(source), nativeAgentsMarkerPath: f.markerPath, opencodeConfigPath: f.configPath, env: {} });
      const response = await app.request("http://localhost/api/openchamber/agent-line");
      expect(await response.json()).toEqual({ line: "omo", source: "marker" });
    } finally {
      await f.cleanup();
    }
  });

  test("writes marker atomically and restarts ai-dev when switching to native", async () => {
    const f = await fixture(["oh-my-openagent"], false);
    let restarted = false;
    try {
      const app = createOpenChamberRoutes({
        command: async (source) => shellCommand(source),
        nativeAgentsMarkerPath: f.markerPath,
        opencodeConfigPath: f.configPath,
        env: {},
        restart: async () => {
          restarted = true;
          return { ok: true };
        },
      });
      const response = await app.request("http://localhost/api/openchamber/agent-line", { method: "POST" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, line: "native", source: "marker" });
      expect(await readFile(f.markerPath, "utf8")).toBe("native agents enabled\n");
      expect(restarted).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  test("restores marker when ai-dev restart fails", async () => {
    const f = await fixture(["oh-my-openagent"], false);
    try {
      const app = createOpenChamberRoutes({
        command: async (source) => shellCommand(source),
        nativeAgentsMarkerPath: f.markerPath,
        opencodeConfigPath: f.configPath,
        env: {},
        restart: async (): Promise<Awaited<ReturnType<typeof restartAiDev>>> => ({ ok: false, error: "restart unavailable" }),
      });
      const response = await app.request("http://localhost/api/openchamber/agent-line", { method: "POST" });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "ai-dev restart failed: restart unavailable" });
      await expect(readFile(f.markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await f.cleanup();
    }
  });
});
