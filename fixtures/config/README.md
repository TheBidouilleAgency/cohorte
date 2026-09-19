# Config samples

Sample `.cohorte/` documents for `packages/config/test/schema/**` (and, later, the loader and the CLI tests).

Every file starts with a header of YAML comments:

| Line | Meaning |
|---|---|
| `# schema: config \| ownership \| spec \| manifest \| skill` | which schema of `@cohorte/config/schema` the document is checked against |
| `# expect: <JSON pointer>` | `invalid/` only: where the document fails (`# expect:` with nothing after it = the document root) |
| `# why: ...` | what the sample pins |

`valid/` documents pass the schema AND the rules a JSON Schema cannot express (`ownershipProblems`,
`frozenSpecProblems`). `invalid/` documents fail one of the two at the documented pointer.

A `config` sample is a complete RESOLVED config (what the run snapshot stores), not a partial project file:
layering is the loader's job.
