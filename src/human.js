// The human's token: written by `bus serve` outside every repo (~/.agentic-chat/<port>.human.token),
// read by human CLI commands, and carried by the dashboard (from the #t=... link) in sessionStorage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** AGENTIC_CHAT_HOME overrides the location (tests). */
export const homeDir = () => process.env.AGENTIC_CHAT_HOME || path.join(os.homedir(), '.agentic-chat');
export const humanTokenFile = (port) => path.join(homeDir(), `${port}.human.token`);

export function writeHumanToken(port, token) {
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(humanTokenFile(port), token + '\n', { mode: 0o600 });
}

export function readHumanToken(port) {
  try { return fs.readFileSync(humanTokenFile(port), 'utf8').trim() || null; } catch { return null; }
}

/** Remove the file on shutdown, but only if it is still ours (another server may have replaced it). */
export function removeHumanToken(port, token) {
  if (readHumanToken(port) === token) try { fs.rmSync(humanTokenFile(port)); } catch { /* ignore */ }
}
