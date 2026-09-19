# Configuration

Project files live under `.cohorte/`. Tightening keys are safe by default; keys that loosen command, provisioning,
network or sandbox policy require a trust record or the explicit `--trust-project-config` consent flag. The
resolved configuration hash is stored in the run snapshot and is never silently changed during resume.
