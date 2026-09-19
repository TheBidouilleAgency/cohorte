// The sole value-import boundary from the bundled Pi implementation. Keeping this module tiny makes the
// production bundle auditable and leaves the RPC/protocol code independent from Pi's public module graph.
export { type AuthEvent, type AuthPrompt, lazyStream, ModelsError } from '@earendil-works/pi-ai';
export {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
export type { TSchema } from 'typebox';
export { Type } from 'typebox';

import '@earendil-works/pi-agent-core';
import '@earendil-works/pi-ai';
import '@earendil-works/pi-coding-agent';
