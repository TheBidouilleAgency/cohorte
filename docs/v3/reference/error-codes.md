# Error codes

Every failure is classified by `@cohorte/base` and rendered with its cause, impact, remediation and exit code.
The authoritative catalogue is `packages/base/src/catalogue.ts`; generated protocol documents carry the same
machine-readable shape.

| Class | Exit code | Meaning |
|---|---:|---|
| usage | 2 | Invalid CLI arguments |
| configuration | 10 | Invalid, unavailable or untrusted project configuration |
| security | 11 | Policy, authentication or integrity violation |
| conflict | 12 | Lock, lease, ownership or merge conflict |
| provider | 13 | Runtime/provider failure |
| corruption | 14 | State, chain or snapshot corruption |
| internal | 15 | Unexpected Cohorte failure |
