import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeCommand, deriveSiblingDevContainerName, dockerCommand, getComposeProject, isValidComposeProjectName } from "./docker";

describe("deriveSiblingDevContainerName", () => {
  test("drops the -admin infix and keeps any suffix", () => {
    expect(deriveSiblingDevContainerName("ai-engkit-admin")).toBe("ai-engkit");
    expect(deriveSiblingDevContainerName("ai-engkit-admin-dev")).toBe("ai-engkit-dev");
    expect(deriveSiblingDevContainerName("ai-engkit-admin-v2")).toBe("ai-engkit-v2");
    expect(deriveSiblingDevContainerName("ai-engkit-admin-v2dev")).toBe("ai-engkit-v2dev");
  });

  test("leaves non-admin names untouched", () => {
    expect(deriveSiblingDevContainerName("ai-engkit")).toBe("ai-engkit");
    expect(deriveSiblingDevContainerName("ai-engkit-v2")).toBe("ai-engkit-v2");
    expect(deriveSiblingDevContainerName("custom")).toBe("custom");
  });
});

describe("isValidComposeProjectName", () => {
  test("accepts lowercase names used in production", () => {
    for (const name of ["ai-engkit", "ai-engkit-dev", "test-proj", "project-name", "a", "a1", "x_y-z9"]) {
      expect(isValidComposeProjectName(name)).toBe(true);
    }
  });

  test("rejects empty, whitespace, and shell-metacharacter input", () => {
    for (const name of [
      "",
      " ",
      "  ",
      "ai engkit",
      "ai-engkit;rm -rf /",
      "ai-engkit&&reboot",
      "ai-engkit|cat",
      "ai-engkit$(id)",
      "ai-engkit`id`",
      "$project",
      "a/b",
      "../x",
      "-leading-dash",
      "Upper",
      "a'b",
      'a"b',
      "a\nb",
    ]) {
      expect(isValidComposeProjectName(name)).toBe(false);
    }
  });
});

interface DockerFixture {
  readonly dir: string;
  readonly env: Record<string, string>;
  readonly options: () => { readonly env: Record<string, string>; readonly dockerBinary: string };
  readonly recordedArgs: () => string[];
  readonly cleanup: () => void;
}

function createDockerFixture(): DockerFixture {
  const dir = mkdtempSync(join(tmpdir(), "docker-shim-"));
  const shimArgsFile = join(dir, "args.log");
  const shim = join(dir, "docker");
  writeFileSync(
    shim,
    "#!/bin/sh\n" +
      'if [ -n "$DOCKER_SHIM_ARGS_FILE" ]; then\n' +
      '  for a in "$@"; do printf \'<\%s>\' "$a" >> "$DOCKER_SHIM_ARGS_FILE"; done\n' +
      '  printf \'\\n\' >> "$DOCKER_SHIM_ARGS_FILE"\n' +
      "fi\n" +
      'if [ -n "$DOCKER_SHIM_STDOUT" ]; then printf \'%s\' "$DOCKER_SHIM_STDOUT"; fi\n' +
      'exit "${DOCKER_SHIM_EXIT:-0}"\n',
  );
  chmodSync(shim, 0o755);
  const env = { DOCKER_SHIM_ARGS_FILE: shimArgsFile };
  return {
    dir,
    env,
    options: () => ({ env, dockerBinary: shim }),
    recordedArgs: () => (existsSync(shimArgsFile) ? readFileSync(shimArgsFile, "utf-8").split("\n").filter(Boolean) : []),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function expectRejected(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let message = "";
  try {
    await promise;
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toMatch(pattern);
}

describe("docker command construction", () => {
  test("Given inspect failure, getComposeProject throws instead of falling back to production", async () => {
    const fixture = createDockerFixture();
    try {
      fixture.env.DOCKER_SHIM_EXIT = "1";
      const error = await getComposeProject(fixture.options()).then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/Failed to detect compose project/);
      expect((error as Error).message).not.toContain('"ai-engkit"');
    } finally {
      fixture.cleanup();
    }
  });

  test("Given a blank project label, getComposeProject throws", async () => {
    const fixture = createDockerFixture();
    try {
      fixture.env.DOCKER_SHIM_STDOUT = "   \n";
      await expectRejected(getComposeProject(fixture.options()), /label is blank/);
    } finally {
      fixture.cleanup();
    }
  });

  test("Given a hostile project label, getComposeProject throws", async () => {
    const fixture = createDockerFixture();
    try {
      fixture.env.DOCKER_SHIM_STDOUT = "ai-engkit; touch pwned";
      await expectRejected(getComposeProject(fixture.options()), /Invalid compose project name/);
      expect(fixture.recordedArgs()).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  test("Given a valid project label, getComposeProject returns it trimmed", async () => {
    const fixture = createDockerFixture();
    try {
      fixture.env.DOCKER_SHIM_STDOUT = "  my-proj  \n";
      expect(await getComposeProject(fixture.options())).toBe("my-proj");
    } finally {
      fixture.cleanup();
    }
  });

  test("Given a quoted --format template, dockerCommand passes it as one argv token without a shell", async () => {
    const fixture = createDockerFixture();
    try {
      const result = await dockerCommand("inspect --format='{{json .Mounts}}' abc123", 10_000, fixture.options());
      expect(result.exitCode).toBe(0);
      expect(fixture.recordedArgs()).toEqual(["<inspect><--format={{json .Mounts}}><abc123>"]);
    } finally {
      fixture.cleanup();
    }
  });

  test("Given a single-quoted injection payload, dockerCommand passes it literally and never executes it", async () => {
    const fixture = createDockerFixture();
    try {
      const marker = join(fixture.dir, "pwned");
      const result = await dockerCommand(`inspect 'a$(touch ${marker})b'`, 10_000, fixture.options());
      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(fixture.recordedArgs()).toEqual([`<inspect><a$(touch ${marker})b>`]);
    } finally {
      fixture.cleanup();
    }
  });

  test("Given a legacy piped subcommand, dockerCommand keeps shell-pipe behavior", async () => {
    const fixture = createDockerFixture();
    try {
      fixture.env.DOCKER_SHIM_STDOUT = "img123";
      const result = await dockerCommand("inspect --format='{{.Image}}' ai-engkit 2>/dev/null | cat", 10_000, fixture.options());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("img123");
    } finally {
      fixture.cleanup();
    }
  });

  test("Given an invalid -p project, dockerCommand throws before executing", async () => {
    const fixture = createDockerFixture();
    try {
      await expectRejected(dockerCommand("compose -p 'evil;touch' up -d", 10_000, fixture.options()), /Invalid compose project name/);
      expect(fixture.recordedArgs()).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test("Given an unbalanced quote, dockerCommand throws instead of corrupting the command", async () => {
    const fixture = createDockerFixture();
    try {
      await expectRejected(dockerCommand("inspect --format='{{.Image}}", 10_000, fixture.options()), /Unbalanced quote/);
      expect(fixture.recordedArgs()).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test("Given an invalid -p project, composeCommand throws before executing", async () => {
    const fixture = createDockerFixture();
    try {
      await expectRejected(
        composeCommand("-p 'a b' --env-file /opt/ai-engkit/.env -f /opt/ai-engkit/compose.yml up -d", 10_000, fixture.options()),
        /Invalid compose project name/,
      );
      expect(fixture.recordedArgs()).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test("Given a valid compose recreate, composeCommand runs argv-direct and drops the trailing 2>&1 no-op", async () => {
    const fixture = createDockerFixture();
    try {
      const result = await composeCommand(
        "-p my-proj --env-file /opt/ai-engkit/.env -f /opt/ai-engkit/compose.yml up -d --force-recreate ai-dev 2>&1",
        10_000,
        fixture.options(),
      );
      expect(result.exitCode).toBe(0);
      expect(fixture.recordedArgs()).toEqual([
        "<compose><-p><my-proj><--env-file></opt/ai-engkit/.env><-f></opt/ai-engkit/compose.yml><up><-d><--force-recreate><ai-dev>",
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  test("Given shell operators in a compose subcommand, composeCommand throws before executing", async () => {
    const fixture = createDockerFixture();
    try {
      await expectRejected(composeCommand("-p my-proj ps | cat", 10_000, fixture.options()), /shell operators/);
      expect(fixture.recordedArgs()).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });
});
