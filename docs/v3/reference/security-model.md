# Security model

Cohorte separates three identities: the human/client control plane, the host that owns durable state, and the
agent runtime. Agents receive only the task, context and tools granted for their surface. Commands and paths are
decided by TypeScript policy and rechecked at use time; prompts never grant permissions.

The default L0 process profile is advisory where the operating system cannot enforce isolation. L1 Seatbelt or
bubblewrap profiles are deny-by-default and report `partial` until their platform escape self-tests pass.
Project configuration that loosens policy requires explicit local trust.
