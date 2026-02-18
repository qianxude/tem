#!/usr/bin/env bun
import { reportCommand } from './commands/report.js';
import { listCommand } from './commands/list.js';

const HELP_TEXT = `tem CLI - Batch diagnostics and reporting tool

Usage: tem <command> [options]

Commands:
  report <db-path> [batch-code]  Generate diagnostic report
  list <db-path>                 List tasks with filtering

Options:
  --help, -h                     Show this help message

Report command options:
  --latest                       Use the most recently created batch
  --limit-errors N               Show top N error patterns (default: 10)

List command options:
  --batch <code>                 Filter by batch code
  --status <status>              Filter by status (pending|running|completed|failed)
  --type <type>                  Filter by task type
  --limit <n>                    Limit results (default: 100)

Examples:
  tem report ./test.db                    # Summary of all batches
  tem report ./test.db my-batch           # Detailed report for batch
  tem report ./test.db --latest           # Report for latest batch
  tem list ./test.db --batch my-batch --status failed --limit 20
`;

function showHelp(): void {
  console.log(HELP_TEXT);
}

function parseArgs(args: string[]): {
  command: string;
  dbPath: string;
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--latest') {
      flags.latest = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        flags[key] = nextArg;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return {
    command: positional[0] || '',
    dbPath: positional[1] || '',
    positional: positional.slice(2),
    flags,
  };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(0);
  }

  const { command, dbPath, positional, flags } = parseArgs(args);

  if (flags.help) {
    showHelp();
    process.exit(0);
  }

  if (!command) {
    console.error('Error: No command specified');
    showHelp();
    process.exit(2);
  }

  if (!dbPath) {
    console.error('Error: Database path required');
    showHelp();
    process.exit(2);
  }

  try {
    switch (command) {
      case 'report':
        await reportCommand(dbPath, positional[0], flags);
        break;
      case 'list':
        await listCommand(dbPath, flags);
        break;
      default:
        console.error(`Error: Unknown command "${command}"`);
        showHelp();
        process.exit(2);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
