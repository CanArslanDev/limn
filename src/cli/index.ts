#!/usr/bin/env node
/**
 * `traceworks` CLI entry point. Phase 2 ships `traceworks inspect`; Phase 4 ships
 * `traceworks init`. Today: surface the version and the list of planned commands
 * so users get a coherent message instead of "command not found".
 */

const args = process.argv.slice(2);
const command = args[0] ?? "help";

const VERSION = "0.0.1";

const HELP = `traceworks ${VERSION}

Usage:
  traceworks inspect [--port <port>]   Open the local trace inspector (Phase 2).
  traceworks init [project-name]       Scaffold a new Traceworks project (Phase 4).
  traceworks --version                 Print the installed version.
  traceworks --help                    Print this message.

Phase 0 ship: only --version and --help respond. inspect / init land in
their respective milestones; until then, browse trace JSON in .traceworks/traces/
directly.
`;

switch (command) {
  case "--version":
  case "-v":
    process.stdout.write(`${VERSION}\n`);
    break;
  case "--help":
  case "-h":
  case "help":
    process.stdout.write(HELP);
    break;
  case "inspect":
    process.stderr.write(
      "traceworks inspect is not implemented yet (Phase 2). Browse .traceworks/traces/ directly.\n",
    );
    process.exit(1);
    break;
  case "init":
    process.stderr.write(
      "traceworks init is not implemented yet (Phase 4). Use the README quickstart.\n",
    );
    process.exit(1);
    break;
  default:
    process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
    process.exit(1);
}
