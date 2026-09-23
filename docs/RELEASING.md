# Releasing the Python package

The Python rewrite is published as `cohorte-engine` on PyPI; its installed command remains
`cohorte`. Its versions and `python-v<version>` Git tags are separate from the legacy npm
`cohorte` package and its `v3.0.0-dev.*` tags. A dev release is a scoped preview, not a claim
that François integration or the complete G5 corpus has passed.

## One-time setup

1. Confirm that the `cohorte-engine` project name is available on PyPI or controlled by the
   Cohorte maintainers. Configure a PyPI Trusted Publisher for GitHub repository
   `TheBidouilleAgency/cohorte`, workflow `release.yml`, environment `pypi`. PyPI supports a
   pending publisher if this is the first upload.
2. Create the GitHub environment `pypi` and protect it with the required reviewers. The
   release workflow requests an OIDC token only in its publish job; no PyPI token is stored in
   GitHub secrets.
3. Keep the existing `DISCORD_FORUM_WEBHOOK` and `DISCORD_THREAD_ID` repository secrets for
   the Cohorte forum thread. The webhook is used only after PyPI publication and GitHub
   release creation. A Discord failure makes the notification job red but does not retract a
   published package.

## Each dev release

1. Choose the next Python version, for example `1.0.0a1`. On a branch, run
   `uv version 1.0.0a1 --no-sync` (substitute the chosen version). Commit both `pyproject.toml`
   and `uv.lock`, then set `src/cohorte/__init__.py` to the same version.
2. Add a `CHANGELOG.md` section headed `## 1.0.0a1 — YYYY-MM-DD`, with concrete bullets. State
   the verified platforms/providers and any open qualification gates. The release check rejects
   a missing section, empty bullets, and TODO placeholders.
3. Run `python scripts/release_meta.py check`, then open and merge a PR to `main` after CI is
   green. The CI matrix builds wheel/sdist, tests a clean install, and checks an installed
   upgrade from the pinned first alpha to the candidate version.
4. Launch **Release Python Cohorte** on `main` in GitHub Actions, or run
   `gh workflow run release.yml --ref main`. The workflow reruns CI, builds and installs the
   release artifact, publishes to PyPI, creates a GitHub release with the changelog and both
   archives, and posts the same notes to Discord. It cannot publish from a feature branch.
5. Verify the PyPI page, the GitHub release, the Discord post, and installation of the actual
   published version in an isolated environment. Example:

   ```bash
   uvx --from 'cohorte-engine==1.0.0a1' cohorte --version
   ```

The GitHub release and Discord post happen only after PyPI accepts the package. If PyPI
succeeds but the Discord step fails, inspect its HTTP status and numeric Discord API code.
After correcting the webhook or thread access, check that the post is absent, then use
**Retry Discord release announcement** on `main` with the existing `python-v<version>` tag.
This sends only the announcement and does not republish the package. Rerunning the full release
also works: `uv publish --check-url` skips identical published files, and the GitHub release
step reuses an existing release. Check the Discord thread first to avoid a duplicate post.
