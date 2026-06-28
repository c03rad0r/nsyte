import { assertEquals, assertExists, assertThrows } from "@std/assert";
import {
  defaultConfig,
  popularBlossomServers,
  popularRelays,
  type ProjectConfig,
  type ProjectContext,
  readProjectFile,
  resolveSetupOverrides,
  type SetupOverrides,
  setupProject,
  writeProjectFile,
} from "../../src/lib/config.ts";
import { encodeBunkerInfo } from "../../src/lib/nip46.ts";
import {
  createMockConfig,
  createTestEnvVars,
  suppressConsole,
  withTestEnvironment,
} from "../utils/test-env.ts";

// Tests for constants (no environment needed)
Deno.test("Config - Constants", async (t) => {
  await t.step("popularRelays should be defined", () => {
    assertExists(popularRelays);
    assertEquals(Array.isArray(popularRelays), true);
    assertEquals(popularRelays.length > 0, true);
    for (const relay of popularRelays) {
      assertEquals(relay.startsWith("wss://"), true);
    }
  });

  await t.step("popularBlossomServers should be defined", () => {
    assertExists(popularBlossomServers);
    assertEquals(Array.isArray(popularBlossomServers), true);
    assertEquals(popularBlossomServers.length > 0, true);
    for (const server of popularBlossomServers) {
      assertEquals(server.startsWith("https://"), true);
    }
  });

  await t.step("defaultConfig should have correct structure", () => {
    assertExists(defaultConfig);
    assertEquals(typeof defaultConfig, "object");
    assertExists(defaultConfig.relays);
    assertExists(defaultConfig.servers);
    assertEquals(Array.isArray(defaultConfig.relays), true);
    assertEquals(Array.isArray(defaultConfig.servers), true);
  });
});

// File operations tests with isolated environment
Deno.test(
  "Config - File Operations",
  withTestEnvironment(async (env, t) => {
    await t.step("writeProjectFile creates directory if not exists", () => {
      const config: ProjectConfig = {
        relays: ["wss://test.relay"],
        servers: ["https://test.server"],
      };

      // Use custom path to bypass temp directory guard
      writeProjectFile(config, env.configFile);

      const stats = Deno.statSync(env.configDir);
      assertEquals(stats.isDirectory, true);

      const fileStats = Deno.statSync(env.configFile);
      assertEquals(fileStats.isFile, true);
    });

    await t.step("writeProjectFile sanitizes bunker URLs", () => {
      const config: ProjectConfig = {
        relays: ["wss://test.relay"],
        servers: ["https://test.server"],
        bunkerPubkey: "1234567890123456789012345678901234567890123456789012345678901234",
      };

      // Use custom path to bypass temp directory guard
      writeProjectFile(config, env.configFile);

      // Suppress console output for this test
      const restoreConsole = suppressConsole();
      try {
        const readConfig = readProjectFile(env.configFile, false); // Skip validation for this test
        restoreConsole();

        assertExists(readConfig);
        assertEquals(readConfig!.bunkerPubkey, config.bunkerPubkey);
      } finally {
        restoreConsole();
      }
    });

    await t.step("writeProjectFile preserves metadata", () => {
      const config: ProjectConfig = {
        relays: ["wss://test.relay"],
        servers: ["https://test.server"],
        id: "test-site",
        title: "Test User",
        description: "Test description",
      };

      // Use custom path to bypass temp directory guard
      writeProjectFile(config, env.configFile);

      const readConfig = readProjectFile(env.configFile, false); // Skip validation
      assertExists(readConfig);
      assertExists(readConfig!.id);
      assertEquals(readConfig!.id, "test-site");
      assertEquals(readConfig!.title, "Test User");
      assertEquals(readConfig!.description, "Test description");
    });

    await t.step("readProjectFile returns null for non-existent file", async () => {
      // Ensure the config file doesn't exist by removing it if it exists
      try {
        await Deno.remove(env.configFile);
      } catch {
        // File doesn't exist, which is what we want
      }

      const result = readProjectFile(undefined, false);
      assertEquals(result, null);
    });

    await t.step("readProjectFile handles malformed JSON", async () => {
      // Write invalid JSON
      await Deno.writeTextFile(env.configFile, "{ invalid json");

      const restoreConsole = suppressConsole();
      try {
        assertThrows(
          () => {
            readProjectFile(undefined, false);
          },
          Error,
          "Invalid JSON in configuration file",
        );
      } finally {
        restoreConsole();
      }
    });
  }),
);

// setupProject tests with isolated environment
Deno.test(
  "Config - setupProject",
  withTestEnvironment(async (env, t) => {
    const envVars = createTestEnvVars();

    try {
      await t.step(
        "returns basic config in non-interactive mode with no existing config",
        async () => {
          // Ensure no config file exists
          try {
            await Deno.remove(env.configFile);
          } catch {
            // File doesn't exist, which is what we want
          }

          const restoreConsole = suppressConsole();
          try {
            const result = await setupProject(true); // skipInteractive = true

            assertExists(result);
            // Should have an error since there's no key configuration and we're in non-interactive mode
            if (result.error) {
              assertEquals(typeof result.error, "string");
            }
          } finally {
            restoreConsole();
          }
        },
      );

      await t.step("returns existing config in non-interactive mode", async () => {
        // Create a valid config first
        const config: ProjectConfig = {
          relays: ["wss://test.relay"],
          servers: ["https://test.server"],
          bunkerPubkey: "1234567890123456789012345678901234567890123456789012345678901234",
        };

        await createMockConfig(env, config);

        const restoreConsole = suppressConsole();
        try {
          const result = await setupProject(true); // skipInteractive = true

          assertExists(result);
          assertExists(result.config);
          assertEquals(result.config.relays, config.relays);
        } finally {
          restoreConsole();
        }
      });
    } finally {
      envVars.restore();
    }
  }),
);

// Utility function tests (no environment needed)
Deno.test("Config - Utility Functions", async (t) => {
  await t.step("should validate project config structure", () => {
    const validConfig: ProjectConfig = {
      relays: ["wss://test.relay"],
      servers: ["https://test.server"],
    };

    // These should not throw when used in isolation
    assertEquals(typeof validConfig.relays, "object");
    assertEquals(Array.isArray(validConfig.relays), true);
    assertEquals(typeof validConfig.servers, "object");
    assertEquals(Array.isArray(validConfig.servers), true);
  });

  await t.step("should handle optional metadata fields", () => {
    const configWithAllFields: ProjectConfig = {
      relays: ["wss://test.relay"],
      servers: ["https://test.server"],
      id: "test-site",
      title: "Test User",
      description: "Test description",
    };

    const configWithMinFields: ProjectConfig = {
      relays: ["wss://test.relay"],
      servers: ["https://test.server"],
    };

    assertEquals(typeof configWithAllFields.title, "string");
    assertEquals(configWithMinFields.title, undefined);
  });
});

// Custom config path tests
Deno.test(
  "Config - Custom Config Path",
  withTestEnvironment(async (env, t) => {
    await t.step("readProjectFile with custom relative path", () => {
      const config: ProjectConfig = {
        relays: ["wss://custom.relay"],
        servers: ["https://custom.server"],
      };

      // Write to custom location
      writeProjectFile(config, env.configFile);

      // Read with explicit path
      const readConfig = readProjectFile(env.configFile, false);
      assertExists(readConfig);
      assertEquals(readConfig!.relays[0], "wss://custom.relay");
    });

    await t.step("readProjectFile with custom absolute path", async () => {
      const customPath = `${env.tempDir}/custom-config.json`;
      const config: ProjectConfig = {
        relays: ["wss://absolute.relay"],
        servers: ["https://absolute.server"],
      };

      // Write config using custom absolute path
      writeProjectFile(config, customPath);

      // Verify file exists at custom location
      const fileStats = await Deno.stat(customPath);
      assertEquals(fileStats.isFile, true);

      // Read from custom path
      const readConfig = readProjectFile(customPath, false);
      assertExists(readConfig);
      assertEquals(readConfig!.relays[0], "wss://absolute.relay");
    });

    await t.step("writeProjectFile with custom path creates correct directory", async () => {
      const customDir = `${env.tempDir}/custom/nested/path`;
      const customPath = `${customDir}/config.json`;
      const config: ProjectConfig = {
        relays: ["wss://nested.relay"],
        servers: ["https://nested.server"],
      };

      // Write to custom nested path
      writeProjectFile(config, customPath);

      // Verify directory and file were created
      const dirStats = await Deno.stat(customDir);
      assertEquals(dirStats.isDirectory, true);

      const fileStats = await Deno.stat(customPath);
      assertEquals(fileStats.isFile, true);

      // Verify content
      const readConfig = readProjectFile(customPath, false);
      assertExists(readConfig);
      assertEquals(readConfig!.relays[0], "wss://nested.relay");
    });

    await t.step("readProjectFile returns null for non-existent custom path", () => {
      const result = readProjectFile("/non/existent/path/config.json", false);
      assertEquals(result, null);
    });

    await t.step("mono-repo scenario: multiple configs in different paths", () => {
      // Simulate a mono-repo with two apps
      const app1ConfigPath = `${env.tempDir}/apps/frontend/.nsite/config.json`;
      const app2ConfigPath = `${env.tempDir}/apps/backend/.nsite/config.json`;

      const app1Config: ProjectConfig = {
        relays: ["wss://frontend.relay"],
        servers: ["https://frontend.server"],
        id: "frontend",
      };

      const app2Config: ProjectConfig = {
        relays: ["wss://backend.relay"],
        servers: ["https://backend.server"],
        id: "backend",
      };

      // Write both configs
      writeProjectFile(app1Config, app1ConfigPath);
      writeProjectFile(app2Config, app2ConfigPath);

      // Read both configs independently
      const readApp1 = readProjectFile(app1ConfigPath, false);
      const readApp2 = readProjectFile(app2ConfigPath, false);

      // Verify they're different and correct
      assertExists(readApp1);
      assertExists(readApp2);
      assertEquals(readApp1!.id, "frontend");
      assertEquals(readApp2!.id, "backend");
      assertEquals(readApp1!.relays[0], "wss://frontend.relay");
      assertEquals(readApp2!.relays[0], "wss://backend.relay");
    });
  }),
);

// Override + environment-variable resolution tests (no environment needed)
Deno.test("Config - resolveSetupOverrides", async (t) => {
  await t.step("CLI flags take precedence over env vars", () => {
    const envVars = createTestEnvVars();
    try {
      envVars.set("NSITE_NSEC", "nsec1envvalue");
      envVars.set("NSITE_RELAYS", "wss://env.relay");
      const resolved = resolveSetupOverrides({ sec: "nsec1cli", relays: "wss://cli.relay" });
      assertEquals(resolved.sec, "nsec1cli");
      assertEquals(resolved.relays, ["wss://cli.relay"]);
      assertEquals(resolved.nonInteractive, false);
    } finally {
      envVars.restore();
    }
  });

  await t.step("env vars used when no CLI flag is provided", () => {
    const envVars = createTestEnvVars();
    try {
      envVars.set("NSITE_NSEC", "nsec1envvalue");
      envVars.set("NOSTR_NSEC", "nsec1othervalue"); // NSITE_NSEC takes priority
      envVars.set("NSITE_RELAYS", "wss://a.relay, wss://b.relay");
      envVars.set("NSITE_SERVERS", "https://s1,https://s2");
      envVars.set("NSITE_SITE_ID", "blog");
      envVars.set("NSITE_BUNKER", "bunker://envbunker");

      const resolved = resolveSetupOverrides();
      assertEquals(resolved.sec, "nsec1envvalue");
      assertEquals(resolved.relays, ["wss://a.relay", "wss://b.relay"]);
      assertEquals(resolved.servers, ["https://s1", "https://s2"]);
      assertEquals(resolved.site, "blog");
      assertEquals(resolved.bunker, "bunker://envbunker");
    } finally {
      envVars.restore();
    }
  });

  await t.step("NBUNK_SECRET is used as the signing secret when NSITE_NSEC is absent", () => {
    const envVars = createTestEnvVars();
    try {
      envVars.set("NBUNK_SECRET", "nbunksec1fromenv");
      const resolved = resolveSetupOverrides();
      assertEquals(resolved.sec, "nbunksec1fromenv");
    } finally {
      envVars.restore();
    }
  });

  await t.step("nonInteractive is set by the flag or NSITE_NON_INTERACTIVE env", () => {
    assertEquals(resolveSetupOverrides({ nonInteractive: true }).nonInteractive, true);
    assertEquals(resolveSetupOverrides({ nonInteractive: false }).nonInteractive, false);

    const envVars = createTestEnvVars();
    try {
      envVars.set("NSITE_NON_INTERACTIVE", "1");
      assertEquals(resolveSetupOverrides().nonInteractive, true);
      envVars.set("NSITE_NON_INTERACTIVE", "true");
      assertEquals(resolveSetupOverrides().nonInteractive, true);
      envVars.set("NSITE_NON_INTERACTIVE", "no");
      assertEquals(resolveSetupOverrides().nonInteractive, false);
    } finally {
      envVars.restore();
    }
  });

  await t.step("defaults to empty when no flags or env vars are set", () => {
    const resolved = resolveSetupOverrides();
    assertEquals(resolved.sec, undefined);
    assertEquals(resolved.bunker, undefined);
    assertEquals(resolved.relays, []);
    assertEquals(resolved.servers, []);
    assertEquals(resolved.site, undefined);
    assertEquals(resolved.nonInteractive, false);
  });

  await t.step("list parsing trims and drops empty entries", () => {
    const resolved = resolveSetupOverrides({
      relays: " wss://one , , wss://two ",
      servers: "https://only",
    });
    assertEquals(resolved.relays, ["wss://one", "wss://two"]);
    assertEquals(resolved.servers, ["https://only"]);
  });
});

// Non-interactive setupProject tests with isolated environment
Deno.test(
  "Config - non-interactive setupProject",
  withTestEnvironment(async (env, t) => {
    // A realistic but throwaway nsec. detectSecretFormat accepts any nsec1-prefixed
    // string; the non-interactive path never decodes it, it just echoes it back.
    const TEST_NSEC = "nsec1zxcv0000112233445566778899aabbccddeeff00112233";
    const envVars = createTestEnvVars();

    /** Remove any leftover config so each step starts clean. */
    async function cleanConfig() {
      try {
        await Deno.remove(env.configFile);
      } catch {
        // already absent
      }
    }

    try {
      await t.step("creates config from --sec + --relays with zero prompts", async () => {
        await cleanConfig();
        const overrides: SetupOverrides = {
          sec: TEST_NSEC,
          relays: "wss://relay.ngit.dev,wss://nos.lol",
          nonInteractive: true,
        };

        const restoreConsole = suppressConsole();
        let result: ProjectContext;
        try {
          result = await setupProject(false, env.configFile, overrides);
        } finally {
          restoreConsole();
        }

        assertEquals(result.error, undefined);
        assertEquals(result.privateKey, TEST_NSEC);
        assertEquals(result.config.relays, ["wss://relay.ngit.dev", "wss://nos.lol"]);
        assertEquals(result.config.servers, []);

        // Config file written and contains valid JSON
        const raw = await Deno.readTextFile(env.configFile);
        const parsed = JSON.parse(raw);
        assertEquals(parsed.relays, ["wss://relay.ngit.dev", "wss://nos.lol"]);
        assertEquals(Array.isArray(parsed.servers), true);
      });

      await t.step("works with env vars only (NSITE_NSEC + NSITE_RELAYS)", async () => {
        await cleanConfig();
        envVars.set("NSITE_NSEC", TEST_NSEC);
        envVars.set("NSITE_RELAYS", "wss://nos.lol");

        const restoreConsole = suppressConsole();
        let result: ProjectContext;
        try {
          result = await setupProject(false, env.configFile, { nonInteractive: true });
        } finally {
          restoreConsole();
        }

        assertEquals(result.error, undefined);
        assertEquals(result.privateKey, TEST_NSEC);
        assertEquals(result.config.relays, ["wss://nos.lol"]);

        // Restore env vars immediately so they don't leak into subsequent steps.
        envVars.restore();
      });

      await t.step("errors when signing key is missing in non-interactive mode", async () => {
        await cleanConfig();
        const restoreConsole = suppressConsole();
        let result: ProjectContext;
        try {
          result = await setupProject(false, env.configFile, {
            relays: "wss://nos.lol",
            nonInteractive: true,
          });
        } finally {
          restoreConsole();
        }
        assertExists(result.error);
        assertEquals(typeof result.error, "string");
      });

      await t.step("nbunksec override stores the derived bunker pubkey", async () => {
        await cleanConfig();
        const pubkey = "a".repeat(64);
        const nbunk = encodeBunkerInfo({
          pubkey,
          relays: ["wss://relay.test"],
          local_key: "b".repeat(64),
        });

        const restoreConsole = suppressConsole();
        let result: ProjectContext;
        try {
          result = await setupProject(false, env.configFile, {
            sec: nbunk,
            nonInteractive: true,
          });
        } finally {
          restoreConsole();
        }

        assertEquals(result.error, undefined);
        assertEquals(result.config.bunkerPubkey, pubkey);
      });

      await t.step("rejects an invalid site identifier in non-interactive mode", async () => {
        await cleanConfig();
        const restoreConsole = suppressConsole();
        let result: ProjectContext;
        try {
          result = await setupProject(false, env.configFile, {
            sec: TEST_NSEC,
            site: "this_identifier_is_far_too_long",
            nonInteractive: true,
          });
        } finally {
          restoreConsole();
        }
        assertExists(result.error);
      });

      await t.step("--site root produces a null id (root site)", async () => {
        await cleanConfig();
        const restoreConsole = suppressConsole();
        let result: ProjectContext;
        try {
          result = await setupProject(false, env.configFile, {
            sec: TEST_NSEC,
            relays: "wss://nos.lol",
            site: "root",
            nonInteractive: true,
          });
        } finally {
          restoreConsole();
        }
        assertEquals(result.error, undefined);
        assertEquals(result.config.id, null);
      });

      await t.step("invalid secret format returns an error", async () => {
        await cleanConfig();
        const restoreConsole = suppressConsole();
        let result: ProjectContext;
        try {
          result = await setupProject(false, env.configFile, {
            sec: "not-a-valid-secret-format",
            relays: "wss://nos.lol",
            nonInteractive: true,
          });
        } finally {
          restoreConsole();
        }
        assertExists(result.error);
      });
    } finally {
      envVars.restore();
    }
  }),
);
