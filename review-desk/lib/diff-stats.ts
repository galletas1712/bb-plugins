export function diffStats(files: readonly { additions: number; deletions: number }[]) {
  // Rename-aware file stats report pure moves as 0/0, without counting the file's contents.
  return files.reduce((total, file) => ({ additions: total.additions + file.additions, deletions: total.deletions + file.deletions }), { additions: 0, deletions: 0 });
}
