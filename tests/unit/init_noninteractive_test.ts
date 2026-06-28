import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { dirname, fromFileUrl, join } from "@std/path";

/**
 * Integration tests for `nsyte init --non-interactive` error propagation.
 *
 * These exercise the real CLI via a `deno run` subprocess (mirroring the pattern
 * in `timestamp_test.ts`), asserting that `init.ts` surfaces `ProjectContext.error`
 * and exits non-zero when required values are missing/invalid, while happy paths
 * still exit 0 and write a valid config.
 *
 * The subprocess runs with its cwd inside the repo (a per-test temp dir) so that
 * `writeProjectFile`'s test-environment heuristic — which blocks writes when the
 * cwd is under `/tmp`, `/var/folders/`, or contains `nsyte-test-` — does NOT
 * suppress the happy-path config write.
 */

// Resolve the CLI entrypoint and repo root relative to this test file.
const cliPath = fromFileUrl(new URL("../../src/cli.ts", import.meta.url));
const repoRoot = dirname(dirname(fromFileUrl(import.meta.url)));

// A realistic but throwaway nsec (matches the one used in config_test.ts). It only
// needs to pass `detectSecretFormat`, not be cryptographically valid.
const TEST_NSEC = "nsec1zxcv0000112233445566778899aabbccddeeff00112233";

// Spawning a subprocess requires --allow-run. CI's coverage task intentionally
// omits --allow-run, so skip these CLI integration tests there; they still run
// locally/under `deno task test:unit` (which uses --allow-all).
const canRunDeno = Deno.permissions.querySync({ name: "run", command: "deno" }).state === "granted";

interface SubprocessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the nsyte CLI as a subprocess and return code + captured streams. */
async function runCli(args: string[], cwd: string): Promise<SubprocessResult> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-all", "--no-check", cliPath, ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  const dec = new TextDecoder();
  return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
}

/** Create a unique temp dir inside the repo (avoids writeProjectFile's /tmp guard). */
function makeTempDir(): string {
  const d = join(
    repoRoot,
    `.init-test-tmp-${Deno.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  Deno.mkdirSync(d, { recursive: true });
  return d;
}

describe("nsyte init --non-interactive error propagation", { ignore: !canRunDeno }, () => {
  it(
    "exits non-zero with a clear error when the signing key is missing",
    { sanitizeOps: false, sanitizeResources: false },
    async () => {
      const cwd = makeTempDir();
      try {
        const result = await runCli(
          ["init", "--relays", "wss://nos.lol", "--non-interactive"],
          cwd,
        );
        assertEquals(
          result.code !== 0,
          true,
          `Expected non-zero exit code, got ${result.code}`,
        );
        assertEquals(
          result.stderr.includes("Missing signing key"),
          true,
          `Expected 'Missing signing key' on stderr, got stderr: ${result.stderr}`,
        );
        // No config should have been written for the error path.
        assertEquals(
          await exists(join(cwd, ".nsite", "config.json")),
          false,
          "No config should be written on the missing-key error path",
        );
      } finally {
        await Deno.remove(cwd, { recursive: true });
      }
    },
  );

  it(
    "exits non-zero when the supplied secret has an invalid format",
    { sanitizeOps: false, sanitizeResources: false },
    async () => {
      const cwd = makeTempDir();
      try {
        const result = await runCli(
          ["init", "--sec", "not-a-valid-secret", "--relays", "wss://nos.lol", "--non-interactive"],
          cwd,
        );
        assertEquals(
          result.code !== 0,
          true,
          `Expected non-zero exit code, got ${result.code}`,
        );
        const combined = result.stdout + result.stderr;
        assertEquals(
          combined.includes("Invalid secret format"),
          true,
          `Expected 'Invalid secret format' in output, got: ${combined}`,
        );
      } finally {
        await Deno.remove(cwd, { recursive: true });
      }
    },
  );

  it(
    "happy path: valid secret + relays exits 0 and writes a valid config",
    { sanitizeOps: false, sanitizeResources: false },
    async () => {
      const cwd = makeTempDir();
      try {
        const result = await runCli(
          ["init", "--sec", TEST_NSEC, "--relays", "wss://nos.lol", "--non-interactive"],
          cwd,
        );
        assertEquals(result.code, 0, `Expected exit 0, got ${result.code}`);
        assertEquals(
          result.stdout.includes("initialized successfully"),
          true,
          `Expected success message, got stdout: ${result.stdout}`,
        );
        // A valid config.json must have been written.
        const configPath = join(cwd, ".nsite", "config.json");
        const configExists = await exists(configPath);
        assertEquals(configExists, true, "Expected .nsite/config.json to be written");
        const config = JSON.parse(await Deno.readTextFile(configPath));
        assertEquals(config.relays, ["wss://nos.lol"]);
        assertEquals(Array.isArray(config.servers), true);
      } finally {
        await Deno.remove(cwd, { recursive: true });
      }
    },
  );
});

/** Lightweight exists() helper that doesn't pull in @std/fs. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
