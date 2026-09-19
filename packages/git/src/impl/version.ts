const VERSION_RE = /git version (\d+)\.(\d+)(?:\.(\d+))?/;

export interface ParsedGitVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
}

/** Parses the first line of `git --version`, e.g. `git version 2.50.1 (Apple Git-155)`. */
export function parseGitVersion(text: string): ParsedGitVersion {
  const match = VERSION_RE.exec(text);
  const major = match?.[1];
  const minor = match?.[2];
  if (major === undefined || minor === undefined) {
    throw new Error(`parseGitVersion: cannot parse ${JSON.stringify(text)}`);
  }
  const patch = match?.[3] ?? '0';
  return { raw: `${major}.${minor}.${patch}`, major: Number(major), minor: Number(minor), patch: Number(patch) };
}

/** True when `version >= min` (dotted `major.minor.patch`, missing components treated as 0). */
export function isAtLeast(version: ParsedGitVersion, min: string): boolean {
  const parts = min.split('.').map(Number);
  const minMajor = parts[0] ?? 0;
  const minMinor = parts[1] ?? 0;
  const minPatch = parts[2] ?? 0;
  if (version.major !== minMajor) return version.major > minMajor;
  if (version.minor !== minMinor) return version.minor > minMinor;
  return version.patch >= minPatch;
}
