/**
 * `<repo>` or `<repo>@<from>`, as typed in the composer or the CLI. `from`
 * is where the repo's new branch starts: a branch, `<remote>/<branch>`, a
 * tag, a full commit id, or a pull request as `#<n>` or `<remote>#<n>`. It
 * never starts with `-`, so git cannot read it as an option.
 */
const REPO_SPEC = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:@[^\s~^:?*[\\-][^\s~^:?*[\\]*)?$/;

/** A repo in a workspace and where its branch started. A null `from` is the default branch. */
export interface RepoEntry {
  name: string;
  from: string | null;
}

export function isRepoSpec(spec: string): boolean {
  return REPO_SPEC.test(spec) && !spec.includes("..") && !spec.includes("@{");
}

/** Splits a valid spec at its first `@`, which repo names never contain. */
export function parseRepoSpec(spec: string): RepoEntry {
  const at = spec.indexOf("@");
  return at === -1 ? { name: spec, from: null } : { name: spec.slice(0, at), from: spec.slice(at + 1) };
}

export function formatRepoSpec({ name, from }: RepoEntry): string {
  return from === null ? name : `${name}@${from}`;
}
