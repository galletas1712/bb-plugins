/** Lines present in unified diff hunks, including context on either side. */
export function hunkLineNumbers(patch: string): { old: Set<number>; new: Set<number> } {
  const old = new Set<number>();
  const next = new Set<number>();
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
    } else if (raw.startsWith("+") && newRemaining > 0) {
      next.add(newLine++);
      newRemaining--;
    } else if (raw.startsWith("-") && oldRemaining > 0) {
      old.add(oldLine++);
      oldRemaining--;
    } else if (raw.startsWith(" ") && oldRemaining > 0 && newRemaining > 0) {
      old.add(oldLine++);
      next.add(newLine++);
      oldRemaining--;
      newRemaining--;
    }
  }
  return { old, new: next };
}
