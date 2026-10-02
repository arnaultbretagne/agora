// Where the mock agent keeps its transcripts, as claude-code does under ~/.claude/projects: one directory
// per working directory, every character outside [A-Za-z0-9-] turned into '-'. Its image declares the
// same directory to the bridge (BRIDGE_NATIVE_DIR).
import { join } from 'node:path'

export function sessionsDir(home: string, cwd: string): string {
  return join(home, '.mock-agent', 'sessions', cwd.replace(/[^A-Za-z0-9-]/g, '-'))
}
