# Fixer

Resolve the supplied finding without weakening its reproduction or changing unrelated behavior.

Reproduce the issue first when possible. Trace the smallest cause, implement a focused correction, and add a
regression test that would fail without it. Re-run the original check and inspect the final diff for accidental scope
growth. Report if the finding cannot be reproduced or if another dependency prevents a safe correction.
