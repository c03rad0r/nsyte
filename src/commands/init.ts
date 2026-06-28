import { colors } from "@cliffy/ansi/colors";
import { Confirm } from "@cliffy/prompt";
import { join } from "@std/path";
import { configDir, type SetupOverrides, setupProject } from "../lib/config.ts";
import { displayColorfulHeader } from "../ui/output-helpers.ts";
import nsyte from "./root.ts";

/**
 * Options for the init command. The signing secret, relay/server lists, site
 * identifier and bunker URL mirror `nsyte deploy` so projects can be bootstrapped
 * non-interactively (e.g. from CI) without the Cliffy TUI.
 */
export interface InitCommandOptions {
  /** Path to config file (global option). */
  config?: string;
  /** Signing secret (auto-detects format: nsec, nbunksec, bunker:// URL, hex). */
  sec?: string;
  /** Comma-separated relay URLs. */
  relays?: string;
  /** Comma-separated Blossom server URLs. */
  servers?: string;
  /** Site identifier (use "root" for the root site). */
  site?: string;
  /** NIP-46 bunker URL (alternative to --sec). */
  bunker?: string;
  /** Run without any TTY prompts; error on missing required values. */
  nonInteractive: boolean;
}

/** Build the setup overrides object from parsed CLI options. */
function overridesFromOptions(options: InitCommandOptions): SetupOverrides {
  return {
    sec: options.sec,
    bunker: options.bunker,
    relays: options.relays,
    servers: options.servers,
    site: options.site,
    nonInteractive: options.nonInteractive === true,
  };
}

/**
 * Register the init command
 */
export function registerInitCommand() {
  return nsyte
    .command("init")
    .description("Initialize a new nsyte project")
    .option(
      "-s, --sec <secret:string>",
      "Signing secret (auto-detects format: nsec, nbunksec, bunker:// URL, or 64-char hex). Same semantics as `nsyte deploy --sec`.",
    )
    .option(
      "-r, --relays <relays:string>",
      'Comma-separated nostr relay URLs (e.g. "wss://relay1,wss://relay2").',
    )
    .option(
      "--servers <servers:string>",
      "Comma-separated Blossom server URLs.",
    )
    .option(
      "--site <id:string>",
      'Site identifier for named sites (defaults to the root site; use "root" explicitly for root).',
    )
    .option(
      "--bunker <url:string>",
      "NIP-46 bunker URL (bunker://...). Alternative to --sec.",
    )
    .option(
      "-i, --non-interactive",
      "Skip all prompts; error if required values are missing. Env vars (NSITE_NSEC, NSITE_RELAYS, ...) are read as fallbacks.",
      { default: false },
    )
    .action(async (options: InitCommandOptions) => {
      console.log(displayColorfulHeader());
      const overrides = overridesFromOptions(options);
      try {
        const result = await setupProject(false, options.config, overrides);
        if (result.error) {
          console.error(colors.red(`\n${result.error}`));
          Deno.exit(1);
        }
        const { config, privateKey } = result;
        printInitSuccess(config, privateKey, "initialized");

        Deno.exit(0);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Check if this is a validation error
        if (
          error instanceof Error && (
            error.message === "Invalid configuration format" ||
            error.message === "Invalid JSON in configuration file"
          )
        ) {
          // Ask user if they want to reinitialize. In non-interactive mode, skip
          // the prompt and default to reinitializing (the override-driven setup
          // will rebuild a valid config from scratch).
          const shouldReinitialize = options.nonInteractive ||
            await Confirm.prompt({
              message:
                "Would you like to reinitialize the configuration? This will overwrite the existing invalid config.",
              default: false,
            });

          if (shouldReinitialize) {
            // Delete the invalid config file
            const configPath = join(Deno.cwd(), configDir, "config.json");
            try {
              await Deno.remove(configPath);
              console.log(colors.yellow("\nRemoved invalid configuration file."));
            } catch (removeError) {
              // File might not exist or already removed, continue anyway
              if (!(removeError instanceof Deno.errors.NotFound)) {
                console.error(
                  colors.red(
                    `\nFailed to remove config file: ${
                      removeError instanceof Error ? removeError.message : String(removeError)
                    }`,
                  ),
                );
                Deno.exit(1);
              }
            }

            // Try setup again
            try {
              const result = await setupProject(false, options.config, overrides);
              if (result.error) {
                console.error(colors.red(`\n${result.error}`));
                Deno.exit(1);
              }
              const { config, privateKey } = result;
              printInitSuccess(config, privateKey, "reinitialized");

              Deno.exit(0);
            } catch (retryError) {
              const retryErrorMessage = retryError instanceof Error
                ? retryError.message
                : String(retryError);
              console.error(colors.red(`\nError reinitializing project: ${retryErrorMessage}`));
              Deno.exit(1);
            }
          } else {
            console.log(
              colors.yellow(
                "\nInitialization cancelled. Please fix the configuration manually or run 'nsyte init' again.",
              ),
            );
            Deno.exit(1);
          }
        } else {
          // For other errors, just display and exit
          console.error(colors.red(`\nError initializing project: ${errorMessage}`));
          Deno.exit(1);
        }
      }
    });
}

/** Print the standard post-init success summary. */
function printInitSuccess(
  config: { bunkerPubkey?: string; relays: string[]; servers: string[]; id?: string | null },
  privateKey: string | undefined | null,
  verb: "initialized" | "reinitialized",
): void {
  if (privateKey || config.bunkerPubkey) {
    const keyType = privateKey ? "private key" : "bunker connection";
    const relayCount = config.relays.length;
    const serverCount = config.servers.length;
    const siteName = config.id || "root";

    console.log(
      colors.green(`\nProject ${verb} successfully with:`),
    );
    console.log(colors.green(`- Site: ${siteName}`));
    console.log(colors.green(`- Authentication: ${keyType}`));
    console.log(colors.green(`- Relays: ${relayCount}`));
    console.log(colors.green(`- Blossom servers: ${serverCount}`));
    console.log(colors.green(`\nConfiguration saved to .nsite/config.json`));
  }
}
