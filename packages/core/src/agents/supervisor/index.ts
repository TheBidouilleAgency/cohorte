// @cohorte/core/agents/supervisor — Wave 0 seam (PLAN U0.08). `map.ts` (the `RuntimeEvent -> Envelope` mapper) is
// Wave 3's (`U3.03`); it is built against the frozen `RUNTIME_EVENT_TARGETS` table of `../../contract/event-mapping.ts`
// and discovers nothing there. See `../../engine/index.ts` for the stub convention.
export { type AgentSupervisorDeps, createAgentSupervisor } from '../../contract/factories.ts';
export { mapRuntimeEvent, runtimeEventTypesHandledByMapper } from './map.ts';
