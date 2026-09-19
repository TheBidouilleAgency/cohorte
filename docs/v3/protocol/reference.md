# Cohorte Protocol reference

Generated from the V3 protocol catalogue. Protocol wire version: **1.0**. Package version: **0.0.0**.

The public protocol is JSON/NDJSON and deliberately runtime-independent. Consumers should validate documents against the published schemas.

## Published schemas

- [agent-output.schema.json](../../../schemas/agent-output.schema.json)
- [auth-status.schema.json](../../../schemas/auth-status.schema.json)
- [command-result.schema.json](../../../schemas/command-result.schema.json)
- [commands.schema.json](../../../schemas/commands.schema.json)
- [config.schema.json](../../../schemas/config.schema.json)
- [doctor-report.schema.json](../../../schemas/doctor-report.schema.json)
- [events.schema.json](../../../schemas/events.schema.json)
- [fake-script.schema.json](../../../schemas/fake-script.schema.json)
- [inspect.schema.json](../../../schemas/inspect.schema.json)
- [manifest.schema.json](../../../schemas/manifest.schema.json)
- [ownership.schema.json](../../../schemas/ownership.schema.json)
- [policy-verdict.schema.json](../../../schemas/policy-verdict.schema.json)
- [project-model.schema.json](../../../schemas/project-model.schema.json)
- [project-status.schema.json](../../../schemas/project-status.schema.json)
- [reconcile-plan.schema.json](../../../schemas/reconcile-plan.schema.json)
- [run-diff.schema.json](../../../schemas/run-diff.schema.json)
- [run-snapshot-manifest.schema.json](../../../schemas/run-snapshot-manifest.schema.json)
- [run-state.schema.json](../../../schemas/run-state.schema.json)
- [runtime-capabilities.schema.json](../../../schemas/runtime-capabilities.schema.json)
- [sandbox-capabilities.schema.json](../../../schemas/sandbox-capabilities.schema.json)
- [skill.schema.json](../../../schemas/skill.schema.json)
- [spec.schema.json](../../../schemas/spec.schema.json)
- [tool-catalogue.schema.json](../../../schemas/tool-catalogue.schema.json)
- [trust-record.schema.json](../../../schemas/trust-record.schema.json)

## Compatibility

- Minor releases may add event types and optional fields.
- Existing event meanings and required fields are not reinterpreted.
- Unknown open-enum values must be preserved by forward-compatible clients.
