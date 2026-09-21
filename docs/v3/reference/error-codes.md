# Error codes

Every failure is classified by `@cohorte/base` and rendered with its cause, impact, remediation and exit code.
The authoritative catalogue is `packages/base/src/catalogue.ts`; generated protocol documents carry the same
machine-readable shape.

| Class | Exit code | Meaning |
|---|---:|---|
| usage | 2 | Invalid CLI arguments |
| configuration | 10 | Invalid or unavailable project configuration |
| validation | 11 | Invalid spec, tool input or agent output |
| permission | 12 | Tool, path or network permission denied |
| security | 13 | Policy, authentication or integrity violation |
| provider | 14 | Transient or terminal runtime/provider failure |
| tool | 15 | Transient or terminal tool failure |
| conflict | 16 | Lock, lease, ownership or merge conflict |
| budget | 17 | Budget exhausted |
| timeout | 18 | Operation timed out |
| corruption | 19 | State, chain or snapshot corruption |
| human-required | 20 | Human decision required |
