// `.cohorte/skills/<id>/skill.yaml` (DESIGN 2.10, ADR-0011). Spec 8 with ONE change: `checks[].command`, a shell
// string, becomes `argv` (D-25, I3). Checks are declarative in V3.0: never run, and they create no CommandRule.
import { ID_PATTERN } from '@cohorte/base';
import { type Static, Type } from 'typebox';

const closed = { additionalProperties: false } as const;
const names = () => Type.Optional(Type.Array(Type.String({ minLength: 1 })));

/** [S] schemas/skill.schema.json */
export const SkillManifest = Type.Object(
  {
    id: Type.String({ pattern: ID_PATTERN }),
    version: Type.String({ minLength: 1 }),
    /** matched against the Project Model, deterministically */
    appliesWhen: Type.Object(
      { languages: names(), frameworks: names(), packageManagers: names(), roles: names() },
      closed,
    ),
    /** relative path of the Markdown, inside the skill directory */
    prompt: Type.String({ minLength: 1 }),
    checks: Type.Optional(
      Type.Array(
        Type.Object(
          { name: Type.Optional(Type.String({ minLength: 1 })), argv: Type.Array(Type.String(), { minItems: 1 }) },
          closed,
        ),
      ),
    ),
    /** reserved (ADR-0011): no signature is verified in V3.0 */
    signature: Type.Optional(Type.String()),
    /** reserved (ADR-0011) */
    source: Type.Optional(Type.String()),
  },
  closed,
);
export type SkillManifest = Static<typeof SkillManifest>;
