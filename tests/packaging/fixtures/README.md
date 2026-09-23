# Pinned upgrade source

`cohorte-local-0.1.0a1-source.tar.gz` is a reduced `git archive` of commit
`ccb23fb6726287bb60056566c8c14ab28cb9727e`, containing its `pyproject.toml`,
README, license, and `src/` tree. The verifier checks its SHA-256 before building the
old wheel. Keeping this 75 KiB fixture in the repository makes the installed-upgrade
test independent of GitHub's handling of pre-squash commits.
