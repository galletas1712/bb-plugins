import {
  experimental_defineHostEntry,
  experimental_killProcessesWithCwdUnder,
} from "@get-bb/plugin-sdk/host";
import { fileDiff, listChanges } from "./changes.js";
import { hostContract } from "./contract.js";
import { ensureWorkspace, pickBranch, removeWorkspace, scanRepos, workspaceRoot } from "./workspace.js";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    scan: async ({ projectPath }) => ({
      repos: (await scanRepos(projectPath)).map((repo) => repo.name),
    }),
    branch: async ({ projectPath, suggested }) => ({ branch: await pickBranch(projectPath, suggested) }),
    ensure: async ({ pathKey, ...rest }, context) => {
      const root = workspaceRoot(context.experimental_paths.dataDir, pathKey);
      const created = await ensureWorkspace({ root, ...rest, signal: context.signal });
      return { path: root, created };
    },
    remove: async ({ pathKey }, context) => {
      const root = workspaceRoot(context.experimental_paths.dataDir, pathKey);
      // Dev servers and shells left in the folder would outlive it.
      await experimental_killProcessesWithCwdUnder({ directories: [root] });
      await removeWorkspace(root);
      return {};
    },
    changes: async ({ root, mode }) => ({ repos: await listChanges(root, mode) }),
    diff: async (input) => ({ patch: await fileDiff(input) }),
  },
});
