// Command registry: built-in commands in this folder + commands contributed by tasks.
// A command file default-exports { name, description, ownerOnly?, run(ctx) }.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

export async function loadCommands(tasks = []) {
  const commands = new Map();
  const add = (cmd, source) => {
    if (!cmd?.name || typeof cmd.run !== 'function') throw new Error(`Invalid command in ${source}`);
    if (commands.has(cmd.name)) throw new Error(`Duplicate command /${cmd.name} (${source})`);
    commands.set(cmd.name, cmd);
  };
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'index.js').sort()) {
    add((await import(pathToFileURL(path.join(dir, file)).href)).default, file);
  }
  for (const task of tasks) for (const cmd of task.commands || []) add(cmd, `task ${task.name}`);
  return commands;
}
