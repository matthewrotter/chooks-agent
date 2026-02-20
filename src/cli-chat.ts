/**
 * CLI Chat Mode for NanoClaw
 * Interactive REPL that sends messages through the container agent.
 * Usage: npm run chat [-- --group <folder>]
 */
import { ChildProcess, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  MAIN_GROUP_FOLDER,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  initDatabase,
  setSession,
} from './db.js';
import { ensureContainerSystemRunning } from './index.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// Suppress pino output in CLI mode — container logs still write to groups/{name}/logs/
logger.level = 'silent';

const CLI_JID = 'cli@local';

// Parse --group argument
function parseArgs(): { groupFolder: string } {
  const args = process.argv.slice(2);
  const groupIdx = args.indexOf('--group');
  const groupFolder =
    groupIdx !== -1 && args[groupIdx + 1]
      ? args[groupIdx + 1]
      : MAIN_GROUP_FOLDER;
  return { groupFolder };
}

// Find the registered group entry by folder name
function findGroupByFolder(
  registeredGroups: Record<string, RegisteredGroup>,
  folder: string,
): { jid: string; group: RegisteredGroup } | null {
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === folder) return { jid, group };
  }
  return null;
}

async function main(): Promise<void> {
  const { groupFolder } = parseArgs();

  // Initialize
  ensureContainerSystemRunning();
  initDatabase();

  const sessions = getAllSessions();
  const registeredGroups = getAllRegisteredGroups();

  const entry = findGroupByFolder(registeredGroups, groupFolder);
  if (!entry) {
    console.error(
      `Error: No registered group with folder "${groupFolder}".`,
    );
    console.error(
      'Available groups:',
      Object.values(registeredGroups)
        .map((g) => g.folder)
        .join(', ') || '(none)',
    );
    process.exit(1);
  }

  const { jid: chatJid, group } = entry;
  const isMain = groupFolder === MAIN_GROUP_FOLDER;

  // Track active container process for cleanup
  let activeProcess: ChildProcess | null = null;
  let activeContainerName: string | null = null;

  // IPC message watcher: print send_message calls from the agent
  const ipcMessagesDir = path.join(DATA_DIR, 'ipc', groupFolder, 'messages');
  fs.mkdirSync(ipcMessagesDir, { recursive: true });
  const ipcInterval = setInterval(() => {
    try {
      const files = fs
        .readdirSync(ipcMessagesDir)
        .filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const filePath = path.join(ipcMessagesDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (data.type === 'message' && data.text) {
            const text = data.text
              .replace(/<internal>[\s\S]*?<\/internal>/g, '')
              .trim();
            if (text) {
              console.log(`\n${ASSISTANT_NAME}: ${text}`);
              rl.prompt();
            }
          }
          fs.unlinkSync(filePath);
        } catch {
          // Skip malformed files
        }
      }
    } catch {
      // Directory may not exist yet
    }
  }, 500);

  // Cleanup on exit
  const cleanup = () => {
    clearInterval(ipcInterval);
    if (activeProcess && !activeProcess.killed) {
      // Write _close sentinel to trigger graceful shutdown
      try {
        activeProcess.stdin?.write('\n_close\n');
        activeProcess.stdin?.end();
      } catch {
        // Process may already be gone
      }
      // Also stop the container directly
      if (activeContainerName) {
        try {
          execSync(`container stop ${activeContainerName}`, {
            stdio: 'pipe',
            timeout: 5000,
          });
        } catch {
          // Best effort
        }
      }
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Welcome banner
  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║  NanoClaw CLI Chat                    ║`);
  console.log(`║  Group: ${group.name.padEnd(29)}║`);
  console.log(`║  Type "exit" or Ctrl+C to quit        ║`);
  console.log(`╚═══════════════════════════════════════╝\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You: ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === 'exit' || input === 'quit') {
      cleanup();
      return;
    }

    // Prepare container input snapshots (same as runAgent in index.ts)
    const tasks = getAllTasks();
    writeTasksSnapshot(
      groupFolder,
      isMain,
      tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
    );

    const chats = getAllChats();
    const registeredJids = new Set(Object.keys(registeredGroups));
    const availableGroups = chats
      .filter((c) => c.jid !== '__group_sync__' && c.is_group)
      .map((c) => ({
        jid: c.jid,
        name: c.name,
        lastActivity: c.last_message_time,
        isRegistered: registeredJids.has(c.jid),
      }));
    writeGroupsSnapshot(groupFolder, isMain, availableGroups, registeredJids);

    const sessionId = sessions[groupFolder];

    // Wrap input as a CLI user message
    const prompt = `<message from="CLI User" timestamp="${new Date().toISOString()}">\n${input}\n</message>`;

    try {
      const output = await runContainerAgent(
        group,
        {
          prompt,
          sessionId,
          groupFolder,
          chatJid,
          isMain,
        },
        (proc, containerName) => {
          activeProcess = proc;
          activeContainerName = containerName;
        },
        async (result: ContainerOutput) => {
          // Update session on the fly
          if (result.newSessionId) {
            sessions[groupFolder] = result.newSessionId;
            setSession(groupFolder, result.newSessionId);
          }

          if (result.result) {
            const raw =
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
            const text = raw
              .replace(/<internal>[\s\S]*?<\/internal>/g, '')
              .trim();
            if (text) {
              console.log(`\n${ASSISTANT_NAME}: ${text}`);
            }
          }
        },
      );

      // Final session update from completed output
      if (output.newSessionId) {
        sessions[groupFolder] = output.newSessionId;
        setSession(groupFolder, output.newSessionId);
      }

      if (output.status === 'error') {
        console.error(`\n[Error: ${output.error || 'Unknown error'}]`);
      }
    } catch (err) {
      console.error(
        `\n[Error: ${err instanceof Error ? err.message : String(err)}]`,
      );
    }

    activeProcess = null;
    activeContainerName = null;
    console.log(); // blank line before next prompt
    rl.prompt();
  });

  rl.on('close', cleanup);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
