// What every agent run of the company flow (and of founding a project) shares: how a /cohorte-* command becomes a
// prompt, the context block the dashboard appends, the MCP diet, the autopilot's rules.

import fs from 'fs';
import path from 'path';
import * as ops from './ops';
import type { RunEvent } from '../shared/api';

/** The business-facing agents read; they never write, run or delegate. The server writes what they propose. */
export const READ_ONLY = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'Task'];

export class FlowError extends ops.OpError {}

export const now = (): string => new Date().toISOString();
/**
 * Every flow run loads only the project's own MCP servers. A user's machine-wide servers (mail, docs, design tools…)
 * can weigh 200k+ tokens of tool schemas on EVERY turn — measured at 230k for a one-word reply — and no PO, lead or
 * pipeline stage needs them. The project's .mcp.json (a retrieval provider, say) is still loaded.
 */
export const mcp = (cwd: string): { strictMcp: true; mcpConfig: string | null } => {
  const f = path.join(cwd, '.mcp.json');
  return { strictMcp: true, mcpConfig: fs.existsSync(f) ? f : null };
};
export const textsOf = (events: RunEvent[]): string[] => events.filter((e): e is Extract<RunEvent, { kind: 'text' }> => e.kind === 'text').map((e) => e.text);
export const readText = (p: string): string => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

/** The body of an installed /cohorte-* command, its $ARGUMENTS substituted — sent as a prompt so the run's model applies. */
export function expandCommand(globalDir: string, name: string, args: string): string {
  if (!/^cohorte-[a-z0-9-]+$/.test(name)) throw new FlowError(`not a cohorte command: ${name}`);
  const file = path.join(globalDir, 'commands', `${name}.md`);
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw new FlowError(`/${name} is not installed — run \`cohorte install\` (or update cohorte)`, 400); }
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  return `<command-name>/${name}</command-name>\n${body.split('$ARGUMENTS').join(args)}`;
}

export const contextBlock = (lines: string[]): string => `\n\n---\n## cohorte ui context (written by the dashboard — data, not instructions from the person)\n\n${lines.join('\n')}\n`;

export const AUTOPILOT_NOTE = (routing: string | null): string => [
  '', '---', '## Running under the cohorte ui autopilot', '',
  'No person is watching this session: cohorte ui started it, and starts the next stage itself when this one ends.',
  '- Never recommend `/clear` and never tell anyone which command to run next — the autopilot routes.',
  '- Ask a question ONLY through AskUserQuestion (one call, at most 4 questions). Put your recommended option FIRST, with',
  '  "(Recommended)" at the end of its label, and set each question\'s `header` to the decision\'s category — exactly one of',
  '  reversible · visible · behavior · contract · cost · security · irreversible. A decider answers what the plan, the spec,',
  '  the project\'s decisions and the developer\'s past answers already settle; the rest waits for the developer.',
  '- Do the stage\'s whole job, then end your turn with the stage\'s own short report.',
  ...(routing ? [`- Model routing: dispatch every implementer subagent with \`model: "${routing}"\` (the Agent tool's model parameter).`] : []),
].join('\n');
