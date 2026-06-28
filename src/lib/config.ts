import { colors } from "@cliffy/ansi/colors";
import { Input, Secret, Select } from "@cliffy/prompt";
import { ensureDirSync } from "@std/fs/ensure-dir";
import { dirname, isAbsolute, join, resolve } from "@std/path";
import { NostrConnectSigner } from "applesauce-signers";
import { detectSecretFormat } from "./auth/secret-detector.ts";
import { formatValidationErrors, validateConfigWithFeedback } from "./config-validator.ts";
import { getErrorMessage } from "./error-utils.ts";
import { createLogger } from "./logger.ts";
import { suggestIdentifier, validateDTag } from "./nip5a.ts";
import { decodeBunkerInfo, getNbunkString, initiateNostrConnect, parseBunkerUrl } from "./nip46.ts";
import { generateKeyPair } from "./nostr.ts";
import { SecretsManager } from "./secrets/mod.ts";

const log = createLogger("config");

export type ProjectConfig = {
  "$schema"?: string; // JSON Schema URL for IDE autocompletion
  bunkerPubkey?: string; // Only store the pubkey reference, not the full URL
  relays: string[];
  servers: string[];
  publishAppHandler?: boolean;
  publishProfile?: boolean; // Publish kind 0 profile metadata (root sites only)
  publishRelayList?: boolean; // Publish kind 10002 relay list (root sites only)
  publishServerList?: boolean; // Publish kind 10063 Blossom server list (root sites only)
  profile?: {
    // Profile metadata for kind 0 events
    name?: string;
    display_name?: string;
    about?: string;
    picture?: string;
    banner?: string;
    website?: string;
    nip05?: string;
    lud16?: string;
    lud06?: string;
  };
  fallback?: string;
  gatewayHostnames?: string[];
  id?: string | "" | null; // Site identifier for named sites (kind 35128). Use empty string or null for root site (kind 15128)
  title?: string; // Optional site title for manifest
  description?: string; // Optional site description for manifest
  source?: string; // Optional repository URL for source tag in manifest
  appHandler?: {
    id?: string; // Optional unique identifier for this handler (defaults to site id)
    kinds: number[]; // Event kinds this nsite can handle/display
    name?: string; // Optional app name for the handler
    description?: string; // Optional description
    icon?: string; // Optional app icon URL
    platforms?: {
      web?: {
        patterns?: Array<{
          url: string; // Full URL pattern (e.g., "https://example.com/e/<bech32>")
          entities?: string[];
        }>;
      };
      android?: string;
      ios?: string;
      macos?: string;
      windows?: string;
      linux?: string;
    };
  };
};

export interface ProjectContext {
  config: ProjectConfig;
  authKeyHex?: string | null;
  privateKey?: string;
  error?: string;
}

export const configDir = ".nsite";
const projectFile = "config.json";

export const popularRelays = [
  "wss://nostr.cercatrova.me",
  "wss://relay.primal.net",
  "wss://relay.wellorder.net",
  "wss://nos.lol",
  "wss://nostr-pub.wellorder.net",
  "wss://relay.damus.io",
];

export const popularBlossomServers = [
  "https://cdn.hzrd149.com",
  "https://cdn.sovbit.host",
  "https://cdn.nostrcheck.me",
  "https://nostr.download",
];

export const CONFIG_SCHEMA_URL = "https://nsyte.run/schemas/config.schema.json";

export const defaultConfig: ProjectConfig = {
  relays: [],
  servers: [],
  gatewayHostnames: [
    "nsite.lol",
  ],
  // appHandler is optional and not included by default
};

/**
 * Resolve the configuration file path
 * @param customPath - Optional custom path to config file (can be relative or absolute)
 * @returns Absolute path to the config file
 */
function resolveConfigPath(customPath?: string): string {
  if (customPath) {
    // If custom path is provided, resolve it relative to CWD
    return isAbsolute(customPath) ? customPath : resolve(Deno.cwd(), customPath);
  }
  // Default: .nsite/config.json in CWD
  return join(Deno.cwd(), configDir, projectFile);
}

/**
 * Sanitize a bunker URL for storage by removing the secret parameter
 */
function sanitizeBunkerUrl(url: string): string {
  try {
    // Skip if not a bunker URL
    if (!url || !url.startsWith("bunker://")) {
      return url;
    }

    // Parse the URL using URL class
    const parsedUrl = new URL(url.replace("bunker://", "https://"));

    // Remove any secret parameter
    parsedUrl.searchParams.delete("secret");

    // Reconstruct the bunker URL without the secret
    const sanitized = `bunker://${parsedUrl.hostname}${parsedUrl.pathname}`;

    // Append relay parameters
    const relays = parsedUrl.searchParams.getAll("relay");
    const relayParams = relays.map((r) => `relay=${encodeURIComponent(r)}`).join("&");

    return relayParams ? `${sanitized}?${relayParams}` : sanitized;
  } catch (error) {
    log.warn(`Failed to sanitize bunker URL: ${error}`);
    return url; // Return original if parsing fails
  }
}

/**
 * Write project configuration to file
 * @param config - The project configuration to write
 * @param configPath - Optional custom path to config file
 */
export function writeProjectFile(config: ProjectConfig, configPath?: string): void {
  const cwd = Deno.cwd();

  // Prevent tests from ever writing to the real project config.
  // Detect test environment via Deno.env or CWD heuristics.
  let hasDenoTestingEnv = false;
  try {
    hasDenoTestingEnv = typeof Deno.env.get("DENO_TESTING") === "string";
  } catch {
    // If env access is not permitted, treat as non-test environment.
    hasDenoTestingEnv = false;
  }
  const isTestEnv = hasDenoTestingEnv ||
    cwd.includes("nsyte-test-") || cwd.includes("/tmp/") || cwd.includes("/var/folders/");

  if (isTestEnv && !configPath) {
    return;
  }

  // If a configPath is provided but resolves to the real project .nsite dir, block in tests
  if (isTestEnv && configPath) {
    const resolved = isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
    // Block if the resolved path is inside the actual nsyte project directory
    if (
      !resolved.includes("nsyte-test-") && !resolved.startsWith("/tmp/") &&
      !resolved.startsWith("/var/")
    ) {
      log.warn(`Blocked test from writing config to project path: ${resolved}`);
      return;
    }
  }

  const projectPath = resolveConfigPath(configPath);

  try {
    // Validate the file extension to prevent accidental YAML file creation
    if (!projectPath.endsWith(".json")) {
      throw new Error(`Invalid config file path: ${projectPath}. Config must be a .json file.`);
    }

    ensureDirSync(dirname(projectPath));

    // Clone the data to avoid modifying the original
    const sanitizedData = { ...config };

    // Validate required fields
    if (!sanitizedData.relays || !Array.isArray(sanitizedData.relays)) {
      throw new Error("Invalid config: 'relays' must be an array");
    }
    if (!sanitizedData.servers || !Array.isArray(sanitizedData.servers)) {
      throw new Error("Invalid config: 'servers' must be an array");
    }

    // Sanitize bunker URL if present to remove secrets
    if (sanitizedData.bunkerPubkey) {
      sanitizedData.bunkerPubkey = sanitizeBunkerUrl(sanitizedData.bunkerPubkey);
    }

    // Create backup of existing config if it exists
    try {
      const existingContent = Deno.readTextFileSync(projectPath);
      const backupPath = `${projectPath}.backup`;
      Deno.writeTextFileSync(backupPath, existingContent);
    } catch {
      // No existing config to backup, which is fine
    }

    Deno.writeTextFileSync(projectPath, JSON.stringify(sanitizedData, null, 2));
    log.success(`Project configuration saved to ${configDir}/${projectFile}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`Failed to save project configuration: ${errorMessage}`);
    throw error;
  }
}

/**
 * Read project configuration from file
 * @param configPath - Optional custom path to config file
 * @param validateSchema - Whether to validate the config against the schema (default: true)
 * @returns The project configuration or null if not found
 */
export function readProjectFile(configPath?: string, validateSchema = true): ProjectConfig | null {
  const projectPath = resolveConfigPath(configPath);
  const cwd = Deno.cwd();

  // Check for common config file mistakes
  const configDirPath = join(cwd, configDir);
  if (fileExists(configDirPath)) {
    // Check for YAML files that shouldn't exist
    const yamlPath = join(configDirPath, "config.yaml");
    const ymlPath = join(configDirPath, "config.yml");

    if (fileExists(yamlPath) || fileExists(ymlPath)) {
      console.error(colors.red("\n⚠️  Found config.yaml/yml file in .nsite directory!"));
      console.error(
        colors.yellow("nsyte uses config.json, not YAML. The YAML file may be from another tool."),
      );
      console.error(colors.yellow("Please remove the YAML file to avoid confusion.\n"));
    }
  }

  try {
    if (!fileExists(projectPath)) {
      log.debug(`Project file not found at ${projectPath}`);
      return null;
    }

    const fileContent = Deno.readTextFileSync(projectPath);
    let config: unknown;

    try {
      config = JSON.parse(fileContent);
    } catch (e) {
      console.error(colors.red("\nFailed to parse configuration file:"));
      console.error(colors.red(`  ${e instanceof Error ? e.message : String(e)}`));
      console.error(colors.yellow("\nPlease ensure .nsite/config.json contains valid JSON."));
      throw new Error("Invalid JSON in configuration file");
    }

    // Validate configuration if requested
    if (validateSchema) {
      const validation = validateConfigWithFeedback(config);

      if (!validation.valid) {
        console.error(colors.red("\nConfiguration validation failed in .nsite/config.json:"));
        console.error(formatValidationErrors(validation.errors));

        if (validation.suggestions.length > 0) {
          console.log(colors.yellow("\nSuggestions:"));
          validation.suggestions.forEach((s) => console.log(`  - ${s}`));
        }

        console.log(
          colors.dim("\nYou can run 'nsyte validate' for more detailed validation information."),
        );

        throw new Error("Invalid configuration format");
      }

      if (validation.warnings.length > 0) {
        console.warn(colors.yellow("Configuration warnings:"));
        validation.warnings.forEach((w) => console.warn(`  - ${w}`));
      }
    }

    return config as ProjectConfig;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`Failed to read project file: ${errorMessage}`);

    // Re-throw validation errors so they can be handled properly
    if (
      error instanceof Error && (
        error.message === "Invalid configuration format" ||
        error.message === "Invalid JSON in configuration file"
      )
    ) {
      throw error;
    }

    return null;
  }
}

/**
 * Check if a file exists
 */
function fileExists(filePath: string): boolean {
  try {
    const stats = Deno.statSync(filePath);
    return stats.isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

/**
 * Overrides supplied by the caller (typically from CLI flags). Values are the
 * raw strings exactly as received on the command line — list-style fields
 * (`relays`, `servers`) are comma-separated and parsed during resolution.
 */
export interface SetupOverrides {
  /** Signing secret (auto-detects format: nsec, nbunksec, bunker:// URL, hex). */
  sec?: string;
  /** NIP-46 bunker URL (alternative to sec). */
  bunker?: string;
  /** Comma-separated relay URLs. */
  relays?: string;
  /** Comma-separated Blossom server URLs. */
  servers?: string;
  /** Site identifier (use "root" for the root site). */
  site?: string;
  /** When true, never prompt — error on missing required values instead. */
  nonInteractive?: boolean;
}

/**
 * Fully-resolved setup inputs after merging CLI overrides with environment
 * variables (CLI flag wins, then env var, then undefined). List fields are
 * parsed into arrays.
 */
export interface ResolvedSetup {
  sec?: string;
  bunker?: string;
  relays: string[];
  servers: string[];
  site?: string;
  nonInteractive: boolean;
}

/** Read an environment variable, treating empty string as unset. Env access
 * is wrapped so the function is safe even without --allow-env. */
function getEnv(key: string): string | undefined {
  try {
    const value = Deno.env.get(key);
    return value && value.trim() !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Parse a comma-separated list string into a trimmed, non-empty array. */
function parseList(value?: string): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Interpret a truthy env var ("1", "true", "yes", "on", case-insensitive). */
function envBool(key: string): boolean {
  const v = getEnv(key);
  return v !== undefined && ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

/**
 * Merge CLI overrides with environment variables.
 *
 * Precedence: explicit CLI flag > environment variable > undefined.
 *
 * Supported env vars:
 *   NSITE_NSEC / NOSTR_NSEC / NBUNK_SECRET -> signing secret
 *   NSITE_BUNKER                            -> bunker URL
 *   NSITE_RELAYS                            -> comma-separated relays
 *   NSITE_SERVERS                           -> comma-separated Blossom servers
 *   NSITE_SITE_ID                           -> site identifier
 *   NSITE_NON_INTERACTIVE                   -> non-interactive mode (1/true/yes/on)
 */
export function resolveSetupOverrides(overrides: SetupOverrides = {}): ResolvedSetup {
  const sec = overrides.sec ?? getEnv("NSITE_NSEC") ?? getEnv("NOSTR_NSEC") ??
    getEnv("NBUNK_SECRET");
  const bunker = overrides.bunker ?? getEnv("NSITE_BUNKER");
  const relays = parseList(overrides.relays ?? getEnv("NSITE_RELAYS"));
  const servers = parseList(overrides.servers ?? getEnv("NSITE_SERVERS"));
  const site = overrides.site ?? getEnv("NSITE_SITE_ID");
  const nonInteractive = overrides.nonInteractive === true || envBool("NSITE_NON_INTERACTIVE");

  return { sec, bunker, relays, servers, site, nonInteractive };
}

/** Persist an nbunksec credential, swallowing keychain errors so a non-interactive
 * init never fails solely because secure storage is unavailable. */
async function storeNbunkSafe(pubkey: string, nbunk: string): Promise<void> {
  try {
    const secretsManager = SecretsManager.getInstance();
    await secretsManager.storeNbunk(pubkey, nbunk);
  } catch (e) {
    log.warn(`Could not store bunker credential in secrets manager: ${getErrorMessage(e)}`);
  }
}

/**
 * Build a project configuration entirely from resolved overrides/environment
 * without any TTY interaction. Writes the resulting config and returns it.
 *
 * Signing secret handling (network-free):
 *  - nsec / hex    -> returned as `privateKey`, never written to config
 *  - nbunksec      -> pubkey stored in config, full credential stored in the
 *                     secrets manager (self-contained, no relay handshake needed)
 *  - bunker:// URL -> pubkey stored in config; the full credential must be
 *                     supplied again at deploy time via --sec/--bunker
 */
async function nonInteractiveSetup(
  existing: ProjectConfig | null,
  resolved: ResolvedSetup,
  configPath?: string,
): Promise<ProjectContext> {
  const hasKey = !!resolved.sec || !!resolved.bunker || !!existing?.bunkerPubkey;
  if (!hasKey) {
    return {
      config: existing ?? { ...defaultConfig },
      privateKey: undefined,
      error:
        "Missing signing key: provide --sec/--bunker or set NSITE_NSEC/NOSTR_NSEC/NBUNK_SECRET/NSITE_BUNKER for non-interactive init.",
    };
  }

  const relays = resolved.relays.length > 0 ? resolved.relays : (existing?.relays ?? []);
  const servers = resolved.servers.length > 0 ? resolved.servers : (existing?.servers ?? []);

  if (relays.length === 0 && servers.length === 0) {
    log.warn(
      "No relays or servers provided for non-interactive init — config will be written but deploy will need --relays/--servers or published relay/server lists.",
    );
  }

  // Resolve site identifier: explicit override > existing > root (null)
  let siteId: string | null;
  if (resolved.site !== undefined) {
    const trimmed = resolved.site.trim();
    siteId = trimmed === "" || trimmed === "root" ? null : trimmed;
  } else if (existing?.id !== undefined && existing.id !== null && existing.id !== "") {
    siteId = existing.id;
  } else {
    siteId = null;
  }

  if (siteId) {
    const validation = validateDTag(siteId);
    if (!validation.valid) {
      const suggestion = suggestIdentifier(siteId);
      const hint = suggestion !== siteId ? ` Try "${suggestion}".` : "";
      return {
        config: { ...defaultConfig, relays, servers, id: siteId },
        privateKey: undefined,
        error: `Invalid site identifier "${siteId}": ${validation.error}.${hint}`,
      };
    }
  }

  const config: ProjectConfig = {
    "$schema": existing?.$schema ?? CONFIG_SCHEMA_URL,
    relays,
    servers,
    id: siteId,
    bunkerPubkey: existing?.bunkerPubkey,
    gatewayHostnames: existing?.gatewayHostnames ?? ["nsite.lol"],
  };
  if (existing?.title) config.title = existing.title;
  if (existing?.description) config.description = existing.description;
  if (existing?.source) config.source = existing.source;

  let privateKey: string | undefined;

  const secretForAuth = resolved.sec ?? resolved.bunker;
  if (secretForAuth) {
    const detected = detectSecretFormat(secretForAuth);
    if (!detected) {
      return {
        config,
        privateKey: undefined,
        error: `Invalid secret format: "${
          secretForAuth.slice(0, 12)
        }...". Expected nsec, nbunksec, bunker:// URL, or 64-char hex.`,
      };
    }
    switch (detected.format) {
      case "nsec":
      case "hex":
        privateKey = detected.value;
        break;
      case "nbunksec": {
        try {
          const info = decodeBunkerInfo(detected.value);
          config.bunkerPubkey = info.pubkey;
          await storeNbunkSafe(info.pubkey, detected.value);
        } catch (e) {
          return {
            config,
            privateKey: undefined,
            error: `Failed to decode nbunksec: ${getErrorMessage(e)}`,
          };
        }
        break;
      }
      case "bunker-url": {
        try {
          const pointer = parseBunkerUrl(detected.value);
          config.bunkerPubkey = pointer.pubkey;
          // A bunker URL needs a live handshake to derive a storable nbunksec,
          // which we avoid here to keep init network-free. The full credential
          // must be passed again at deploy time via --sec/--bunker.
          log.info(
            `Configured bunker ${
              pointer.pubkey.slice(0, 8)
            }... — supply the bunker URL via --sec/--bunker at deploy time.`,
          );
        } catch (e) {
          return {
            config,
            privateKey: undefined,
            error: `Failed to parse bunker URL: ${getErrorMessage(e)}`,
          };
        }
        break;
      }
    }
  }

  writeProjectFile(config, configPath);
  return { config, privateKey };
}

/**
 * Setup project configuration.
 *
 * @param skipInteractive If true, return a basic configuration without prompting
 *                        (legacy behaviour used by some non-init code paths).
 * @param configPath      Optional custom path to config file.
 * @param overrides       Optional CLI/env overrides. When `nonInteractive` is set
 *                        (or `NSITE_NON_INTERACTIVE` is truthy), the project is
 *                        bootstrapped entirely from overrides/environment with
 *                        zero TTY interaction; provided values also skip their
 *                        corresponding prompts in interactive mode.
 */
export async function setupProject(
  skipInteractive = false,
  configPath?: string,
  overrides: SetupOverrides = {},
): Promise<ProjectContext> {
  const resolved = resolveSetupOverrides(overrides);
  const nonInteractive = resolved.nonInteractive;

  let config: ProjectConfig | null = null;
  let privateKey: string | undefined;

  try {
    config = readProjectFile(configPath);
  } catch (error) {
    // If there's a validation error, don't proceed with setup
    if (
      error instanceof Error && (
        error.message === "Invalid configuration format" ||
        error.message === "Invalid JSON in configuration file"
      )
    ) {
      throw error;
    }
    // For other errors, continue with setup
    config = null;
  }

  // Non-interactive, override-driven bootstrap (no TTY).
  if (nonInteractive) {
    return nonInteractiveSetup(config, resolved, configPath);
  }

  if (!config) {
    if (skipInteractive) {
      // Return a basic configuration without prompting
      config = {
        relays: [],
        servers: [],
      };
      log.debug("Running in non-interactive mode with no existing configuration");
      return { config, privateKey: undefined };
    }

    console.log(colors.cyan("No existing project configuration found. Setting up a new one:"));
    const setupResult = await interactiveSetup(resolved);
    config = setupResult.config;
    privateKey = setupResult.privateKey;
    writeProjectFile(config, configPath);
  }

  // In legacy non-interactive mode, don't proceed with key setup prompts
  if (skipInteractive) {
    if (!config.bunkerPubkey && !privateKey) {
      log.error(
        "No key configuration found and running in non-interactive mode. Please provide key configuration via CLI arguments.",
      );
      Deno.exit(1);
    }
    return { config, privateKey };
  }

  // Only proceed with interactive key setup if we're in interactive mode and no
  // key is configured or supplied via overrides.
  const overrideKey = resolved.sec ?? resolved.bunker;
  if (overrideKey) {
    const detected = detectSecretFormat(overrideKey);
    if (detected && (detected.format === "nsec" || detected.format === "hex")) {
      privateKey = detected.value;
    }
  }

  if (!config.bunkerPubkey && !privateKey) {
    const keyResult = await selectKeySource(config, configPath, resolved);
    config = keyResult.config;
    privateKey = keyResult.privateKey;
  }

  return { config, privateKey };
}

async function connectToBunkerWithQR(): Promise<NostrConnectSigner> {
  const appName = "nsyte";
  const defaultRelays = ["wss://relay.nsec.app"];

  const relayInput = await Input.prompt({
    message: `Enter relays (comma-separated), or press Enter for default (${
      defaultRelays.join(", ")
    }):`,
    default: defaultRelays.join(", "),
  });

  let chosenRelays: string[];
  if (relayInput.trim() === "" || relayInput.trim() === defaultRelays.join(", ")) {
    chosenRelays = defaultRelays;
  } else {
    chosenRelays = relayInput.split(",").map((r) => r.trim()).filter((r) => r.length > 0);
  }

  if (chosenRelays.length === 0) {
    console.log(colors.yellow("No relays provided. Using default relays."));
    chosenRelays = defaultRelays;
  }

  console.log(
    colors.cyan(`Initiating Nostr Connect as '${appName}' on relays: ${chosenRelays.join(", ")}`),
  );
  return initiateNostrConnect(appName, chosenRelays);
}

async function connectToBunkerWithURI(): Promise<NostrConnectSigner> {
  const bunkerUrl = await Input.prompt({
    message: "Enter the bunker URL (bunker://...):",
    validate: (input: string) => {
      return input.trim().startsWith("bunker://") ||
        "Bunker URL must start with bunker:// (format: bunker://<pubkey>?relay=...)";
    },
  });

  console.log(colors.cyan("Connecting to bunker via URL..."));
  return NostrConnectSigner.fromBunkerURI(bunkerUrl);
}

async function newBunker(): Promise<NostrConnectSigner | undefined> {
  let signer: NostrConnectSigner | null = null;

  const choice = await Select.prompt<string>({
    message: "How would you like to connect to the bunker?",
    options: [
      { name: "Scan QR Code (Nostr Connect)", value: "qr" },
      { name: "Enter Bunker URL manually", value: "url" },
    ],
  });

  try {
    signer = choice === "qr" ? await connectToBunkerWithQR() : await connectToBunkerWithURI();

    if (!signer) {
      throw new Error("Failed to establish signer connection");
    }

    return signer;
  } catch (error) {
    log.error(`Failed to connect to bunker: ${error}`);
    console.error(
      colors.red(
        `Failed to connect to bunker: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    Deno.exit(1);
  } finally {
    if (signer) {
      try {
        console.log(colors.cyan("Disconnecting from bunker..."));
        await signer.close();
        console.log(colors.green("Disconnected from bunker."));
      } catch (err) {
        console.error(colors.red(`Error during disconnect: ${err}`));
      }
    }
  }
}

async function selectKeySource(
  existingConfig?: ProjectConfig,
  configPath?: string,
  resolved?: ResolvedSetup,
): Promise<{ config: ProjectConfig; privateKey?: string }> {
  // If a signing secret was supplied via overrides, resolve it directly without
  // prompting (mirrors the non-interactive key handling, network-free).
  const overrideSecret = resolved?.sec ?? resolved?.bunker;
  if (overrideSecret) {
    const config: ProjectConfig = existingConfig
      ? structuredClone(existingConfig)
      : structuredClone(defaultConfig);
    let privateKey: string | undefined;
    const detected = detectSecretFormat(overrideSecret);
    if (detected) {
      if (detected.format === "nsec" || detected.format === "hex") {
        privateKey = detected.value;
      } else if (detected.format === "nbunksec") {
        try {
          const info = decodeBunkerInfo(detected.value);
          config.bunkerPubkey = info.pubkey;
          await storeNbunkSafe(info.pubkey, detected.value);
        } catch (e) {
          log.warn(`Could not decode nbunksec override: ${getErrorMessage(e)}`);
        }
      } else if (detected.format === "bunker-url") {
        try {
          config.bunkerPubkey = parseBunkerUrl(detected.value).pubkey;
        } catch (e) {
          log.warn(`Could not parse bunker URL override: ${getErrorMessage(e)}`);
        }
      }
      if (privateKey || config.bunkerPubkey) {
        writeProjectFile(config, configPath);
        console.log(colors.green("Key configuration applied from CLI/env override."));
        return { config, privateKey };
      }
    }
  }

  console.log(colors.yellow("No key configuration found. Let's set that up:"));

  let privateKey: string | undefined;
  const config: ProjectConfig = existingConfig
    ? structuredClone(existingConfig)
    : structuredClone(defaultConfig);

  // Store the original bunkerPubkey to check if it changed
  const originalBunkerPubkey = config.bunkerPubkey;
  let configChanged = false;

  // Check if there are any existing bunkers
  const secretsManager = SecretsManager.getInstance();
  const existingBunkers = await secretsManager.getAllPubkeys();
  const hasBunkers = existingBunkers.length > 0;

  // Prepare options based on whether bunkers exist
  const keyOptions = [
    { name: "Generate a new private key", value: "generate" },
    { name: "Use an existing private key", value: "existing" },
  ];

  if (hasBunkers) {
    keyOptions.push(
      { name: "Use an existing NSEC bunker", value: "existing_bunker" },
      { name: "Connect to a new NSEC bunker", value: "new_bunker" },
    );
  } else {
    keyOptions.push({ name: "Connect to an NSEC bunker", value: "new_bunker" });
  }

  // Define the type for the key choice to avoid type errors
  type KeyChoice = "generate" | "existing" | "new_bunker" | "existing_bunker";

  const keyChoice = await Select.prompt<KeyChoice>({
    message: "How would you like to manage your nostr key?",
    options: keyOptions,
  });

  if (keyChoice === "generate") {
    const keyPair = generateKeyPair();
    privateKey = keyPair.privateKey;
    console.log(colors.green(`Generated new private key: ${keyPair.privateKey}`));
    console.log(
      colors.yellow(
        "IMPORTANT: Save this key securely. It will not be stored and cannot be recovered!",
      ),
    );
    console.log(colors.green(`Your public key is: ${keyPair.publicKey}`));
    // Note: privateKey is returned but not stored in config, so no config change
  } else if (keyChoice === "existing") {
    privateKey = await Secret.prompt({
      message: "Enter your nostr private key (nsec/hex):",
    });
    // Note: privateKey is returned but not stored in config, so no config change
  } else if (keyChoice === "new_bunker") {
    const signer = await newBunker();
    if (signer) {
      config.bunkerPubkey = await signer.getPublicKey();
      const nbunkString = getNbunkString(signer);
      await secretsManager.storeNbunk(config.bunkerPubkey, nbunkString);
      console.log(
        colors.green(
          `Successfully connected to bunker ${
            config.bunkerPubkey.slice(0, 8)
          }... \nGenerated and stored nbunksec string.`,
        ),
      );
      configChanged = true;
    }
  } else if (keyChoice === "existing_bunker") {
    // Present a list of existing bunkers to choose from
    const bunkerOptions = existingBunkers.map((pubkey: string) => {
      return {
        name: `${pubkey.slice(0, 8)}...${pubkey.slice(-4)}`,
        value: pubkey,
      };
    });

    const selectedPubkey = await Select.prompt<string>({
      message: "Select an existing bunker:",
      options: bunkerOptions,
    });

    config.bunkerPubkey = selectedPubkey;
    console.log(
      colors.green(`Using existing bunker with pubkey: ${selectedPubkey.slice(0, 8)}...`),
    );
    configChanged = originalBunkerPubkey !== selectedPubkey;
  }

  // Only write config if it actually changed
  if (configChanged || !existingConfig) {
    writeProjectFile(config, configPath);
    console.log(colors.green("Key configuration set up successfully!"));
  } else {
    console.log(colors.green("Key configuration completed."));
  }

  return { config, privateKey };
}

/**
 * Interactive project setup
 */
async function interactiveSetup(resolved?: ResolvedSetup): Promise<ProjectContext> {
  console.log(colors.cyan("Welcome to nsyte setup!"));

  let privateKey: string | undefined;
  let bunkerPubkey: string | undefined;
  let keyFromOverride = false;

  // Honor an explicit signing secret override without prompting.
  const overrideSecret = resolved?.sec ?? resolved?.bunker;
  if (overrideSecret) {
    const detected = detectSecretFormat(overrideSecret);
    if (detected) {
      if (detected.format === "nsec" || detected.format === "hex") {
        privateKey = detected.value;
        keyFromOverride = true;
        console.log(colors.green("Using signing key from CLI/env override."));
      } else if (detected.format === "nbunksec") {
        try {
          const info = decodeBunkerInfo(detected.value);
          bunkerPubkey = info.pubkey;
          await storeNbunkSafe(info.pubkey, detected.value);
          keyFromOverride = true;
          console.log(
            colors.green(`Using bunker ${info.pubkey.slice(0, 8)}... from CLI/env override.`),
          );
        } catch (e) {
          log.warn(`Could not decode nbunksec override: ${getErrorMessage(e)}`);
        }
      } else if (detected.format === "bunker-url") {
        try {
          bunkerPubkey = parseBunkerUrl(detected.value).pubkey;
          keyFromOverride = true;
          console.log(
            colors.green(`Using bunker ${bunkerPubkey.slice(0, 8)}... from CLI/env override.`),
          );
        } catch (e) {
          log.warn(`Could not parse bunker URL override: ${getErrorMessage(e)}`);
        }
      }
    }
  }

  // Check if there are any existing bunkers
  const secretsManager = SecretsManager.getInstance();
  const existingBunkers = await secretsManager.getAllPubkeys();
  const hasBunkers = existingBunkers.length > 0;

  // Prepare options based on whether bunkers exist
  const keyOptions = [
    { name: "Generate a new private key", value: "generate" },
    { name: "Use an existing private key", value: "existing" },
  ];

  if (hasBunkers) {
    keyOptions.push(
      { name: "Use an existing NSEC bunker", value: "existing_bunker" },
      { name: "Connect to a new NSEC bunker", value: "new_bunker" },
    );
  } else {
    keyOptions.push({ name: "Connect to an NSEC bunker", value: "new_bunker" });
  }

  // Define the type for the key choice to avoid type errors
  type KeyChoice = "generate" | "existing" | "new_bunker" | "existing_bunker";

  // Skip the key-selection prompt when a key was supplied via overrides.
  const keyChoice: KeyChoice | null = keyFromOverride ? null : await Select.prompt<KeyChoice>({
    message: "How would you like to manage your nostr key?",
    options: keyOptions,
  });

  if (keyChoice === "generate") {
    const keyPair = generateKeyPair();
    privateKey = keyPair.privateKey;
    console.log(colors.green(`Generated new private key: ${keyPair.privateKey}`));
    console.log(
      colors.yellow(
        "IMPORTANT: Save this key securely. It will not be stored and cannot be recovered!",
      ),
    );
    console.log(colors.green(`Your public key is: ${keyPair.publicKey}`));
  } else if (keyChoice === "existing") {
    privateKey = await Secret.prompt({
      message: "Enter your nostr private key (nsec/hex):",
    });
  } else if (keyChoice === "new_bunker") {
    const choice = await Select.prompt<string>({
      message: "How would you like to connect to the bunker?",
      options: [
        { name: "Scan QR Code (Nostr Connect)", value: "qr" },
        { name: "Enter Bunker URL manually", value: "url" },
      ],
    });

    let signer: NostrConnectSigner | null = null;

    try {
      if (choice === "qr") {
        const appName = "nsyte";
        const defaultRelays = ["wss://relay.nsec.app"];

        const relayInput = await Input.prompt({
          message: `Enter relays (comma-separated), or press Enter for default (${
            defaultRelays.join(", ")
          }):`,
          default: defaultRelays.join(", "),
        });

        let chosenRelays: string[];
        if (relayInput.trim() === "" || relayInput.trim() === defaultRelays.join(", ")) {
          chosenRelays = defaultRelays;
        } else {
          chosenRelays = relayInput.split(",").map((r) => r.trim()).filter((r) => r.length > 0);
        }

        if (chosenRelays.length === 0) {
          console.log(colors.yellow("No relays provided. Using default relays."));
          chosenRelays = defaultRelays;
        }

        console.log(
          colors.cyan(
            `Initiating Nostr Connect as '${appName}' on relays: ${chosenRelays.join(", ")}`,
          ),
        );
        signer = await initiateNostrConnect(appName, chosenRelays);
      } else {
        const bunkerUrl = await Input.prompt({
          message: "Enter the bunker URL (bunker://...):",
          validate: (input: string) => {
            return input.trim().startsWith("bunker://") ||
              "Bunker URL must start with bunker:// (format: bunker://<pubkey>?relay=...)";
          },
        });

        console.log(colors.cyan("Connecting to bunker via URL..."));
        signer = await NostrConnectSigner.fromBunkerURI(bunkerUrl);
      }

      if (!signer) {
        throw new Error("Failed to establish signer connection");
      }

      bunkerPubkey = await signer.getPublicKey();
      const nbunkString = getNbunkString(signer);
      await secretsManager.storeNbunk(bunkerPubkey, nbunkString);

      console.log(colors.green(`Successfully connected to bunker ${bunkerPubkey.slice(0, 8)}...
Generated and stored nbunksec string.`));
    } catch (error) {
      log.error(`Failed to connect to bunker: ${error}`);
      console.error(
        colors.red(
          `Failed to connect to bunker: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      Deno.exit(1);
    } finally {
      if (signer) {
        try {
          console.log(colors.cyan("Disconnecting from bunker..."));
          await signer.close();
          console.log(colors.green("Disconnected from bunker."));
        } catch (err) {
          console.error(colors.red(`Error during disconnect: ${err}`));
        }
      }
    }
  } else if (keyChoice === "existing_bunker") {
    // Present a list of existing bunkers to choose from
    const bunkerOptions = existingBunkers.map((pubkey: string) => {
      return {
        name: `${pubkey.slice(0, 8)}...${pubkey.slice(-4)}`,
        value: pubkey,
      };
    });

    const selectedPubkey = await Select.prompt<string>({
      message: "Select an existing bunker:",
      options: bunkerOptions,
    });

    bunkerPubkey = selectedPubkey;
    console.log(
      colors.green(`Using existing bunker with pubkey: ${selectedPubkey.slice(0, 8)}...`),
    );
  }

  // Ask if this is a root site or named site (skip when --site override given)
  let siteId: string | null | undefined;
  if (resolved?.site !== undefined) {
    const trimmed = resolved.site.trim();
    siteId = trimmed === "" || trimmed === "root" ? null : trimmed;
  } else {
    const siteType = await Select.prompt<string>({
      message: "What type of site are you creating?",
      options: [
        { name: "Root site - e.g., npub1xxxx.nsite.lol", value: "root" },
        { name: "Named site - e.g., {base36pubkey}blog.nsite.lol", value: "named" },
      ],
    });

    if (siteType === "named") {
      const identifier = await Input.prompt({
        message: "Enter site identifier (lowercase, max 13 chars, e.g., blog, my-site):",
        validate: (input: string) => {
          const trimmed = input.trim();
          if (!trimmed) {
            return "Site identifier is required";
          }
          const result = validateDTag(trimmed);
          if (!result.valid) {
            const suggestion = suggestIdentifier(trimmed);
            return `${result.error}${suggestion !== trimmed ? `. Try "${suggestion}"` : ""}`;
          }
          return true;
        },
      });
      siteId = identifier.trim();
    } else {
      // Root site: set id to null or empty string
      siteId = null;
    }
  }

  const siteTitle = await Input.prompt({
    message: "Enter site title (optional):",
  });

  const siteDescription = await Input.prompt({
    message: "Enter site description (optional):",
  });

  // Use override relays/servers when provided; otherwise prompt interactively.
  const relays = resolved && resolved.relays.length > 0
    ? resolved.relays
    : await promptForUrlsWithHeader(
      "\nEnter nostr relay URLs (leave empty when done):",
      "Enter relay URL:",
      popularRelays,
    );

  const servers = resolved && resolved.servers.length > 0
    ? resolved.servers
    : await promptForUrlsWithHeader(
      "\nEnter blossom server URLs (leave empty when done):",
      "Enter blossom server URL:",
      popularBlossomServers,
    );

  const config: ProjectConfig = {
    "$schema": CONFIG_SCHEMA_URL,
    bunkerPubkey,
    relays,
    servers,
    id: siteId,
    title: siteTitle || undefined,
    description: siteDescription || undefined,
  };

  return { config, privateKey };
}

/**
 * Prompt for URLs with suggestions
 */
async function promptForUrls(message: string, suggestions: string[]): Promise<string[]> {
  const urls: string[] = [];

  while (true) {
    const url = await Input.prompt({
      message,
      suggestions,
      list: true,
    });

    if (!url) break;

    if (
      url.startsWith("http://") || url.startsWith("https://") ||
      url.startsWith("ws://") || url.startsWith("wss://")
    ) {
      urls.push(url);
    } else {
      console.log(
        colors.yellow(
          "Invalid URL format. Please include the protocol (http://, https://, ws://, wss://)",
        ),
      );
    }
  }

  return urls;
}

/**
 * Print a header line, then prompt for URLs with suggestions.
 */
function promptForUrlsWithHeader(
  header: string,
  message: string,
  suggestions: string[],
): Promise<string[]> {
  console.log(colors.cyan(header));
  return promptForUrls(message, suggestions);
}
