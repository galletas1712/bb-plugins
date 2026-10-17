import type { Result, Run, ResponseHeaders } from "./github-rate-limit";

/** Conditional REST reads, with a separate ETag and body for every page. */
export function withGitHubCache(execute: Run): Run {
  const cache = new Map<string, { body: string; headers: ResponseHeaders; bytes: number }>();
  const pending = new Map<string, Promise<Result>>();
  let bytes = 0;
  return async (cmd, args, options = {}) => {
    const endpoint = args.findIndex((arg) => arg.startsWith("repos/") || arg.startsWith("https://"));
    const method = args.indexOf("-X") >= 0 ? args[args.indexOf("-X") + 1] : args.indexOf("--method") >= 0 ? args[args.indexOf("--method") + 1] : "GET";
    if (cmd !== "gh" || args[0] !== "api" || endpoint < 0 || method !== "GET" || options.input !== undefined || args.some((arg) => ["-f", "-F", "--field", "--raw-field", "--input", "--jq", "--template"].includes(arg)) || args.includes("--paginate") && !args.includes("--slurp")) return execute(cmd, args, options);
    const paginate = args.includes("--paginate");
    const slurp = args.includes("--slurp");
    let page: string | undefined = args[endpoint];
    const pages: string[] = [];
    const visited = new Set<string>();
    let last: Result;
    do {
      if (visited.has(page)) throw new Error("GitHub returned a repeated pagination link");
      visited.add(page);
      const pageArgs = args.map((arg, index) => index === endpoint ? page! : arg).filter((arg) => arg !== "--paginate" && arg !== "--slurp");
      const key = JSON.stringify([options.cwd ?? "", pageArgs]);
      let work = pending.get(key);
      if (!work) {
        work = (async () => {
          const previous = cache.get(key);
          const etag = previous?.headers.values.get("etag");
          const result = await execute(cmd, etag ? [...pageArgs, "-H", `If-None-Match: ${etag}`] : pageArgs, { ...options, allowFailure: true });
          let headers = result.headers?.at(-1);
          if (headers?.status === 304 && previous) {
            headers = { ...headers, values: new Map([...previous.headers.values, ...headers.values]) };
            return { ...result, stdout: previous.body, code: 0, stderr: "", headers: [headers] };
          }
          if (result.code === 0 && headers?.status === 200) {
            if (previous) { cache.delete(key); bytes -= previous.bytes; }
            const size = Buffer.byteLength(result.stdout);
            if (headers.values.has("etag") && size <= 4 * 1024 * 1024) {
              cache.set(key, { body: result.stdout, headers, bytes: size }); bytes += size;
              while (cache.size > 256 || bytes > 8 * 1024 * 1024) {
                const oldest = cache.keys().next().value!;
                bytes -= cache.get(oldest)!.bytes; cache.delete(oldest);
              }
            }
          }
          return result;
        })();
        pending.set(key, work);
        void work.finally(() => { if (pending.get(key) === work) pending.delete(key); }).catch(() => undefined);
      }
      last = await work;
      if (last.code !== 0) {
        if (options.allowFailure) return last;
        throw new Error(`gh api failed: ${(last.stderr || last.stdout).trim().slice(0, 600)}`);
      }
      pages.push(last.stdout);
      page = paginate ? last.headers?.at(-1)?.values.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] : undefined;
    } while (page);
    return { ...last, stdout: slurp ? `[${pages.join(",")}]` : pages[0] };
  };
}
