export type Result = { stdout: string; stderr: string; code: number; headers?: ResponseHeaders[] };
type Options = { cwd?: string; input?: string; allowFailure?: boolean };
export type Run = (cmd: string, args: string[], options?: Options) => Promise<Result>;

export interface ResponseHeaders { status: number; values: Map<string, string> }

// gh writes headers inside the outer JSON array when --slurp is used.
// Real header blocks contain newlines, unlike header-like text in JSON strings.
function responseBody(stdout: string): { body: string; headers: ResponseHeaders[] } {
  const headers: ResponseHeaders[] = [];
  const body = stdout.replace(/(^|[\n\[,])HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n((?:[\w!#$%&'*+.^`|~-]+:[^\r\n]*\r?\n)*)\r?\n/g, (_, prefix: string, status: string, lines: string) => {
    const values = new Map<string, string>();
    for (const line of lines.trim().split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon > 0) values.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
    }
    headers.push({ status: Number(status), values });
    return prefix;
  });
  return { body, headers };
}

function limitResponse(result: Result, headers: ResponseHeaders[], now: number) {
  let errors: { message?: string; type?: string; code?: string; extensions?: { code?: string } }[] = [];
  let message = "";
  try {
    const data = JSON.parse(result.stdout);
    if (data && !Array.isArray(data)) {
      errors = Array.isArray(data.errors) ? data.errors : [];
      message = typeof data.message === "string" ? data.message : "";
    }
  } catch { /* A failed paginated request can leave an incomplete JSON body. */ }
  const rateMessage = /\b(?:api |secondary |primary )rate[ -]?limit\b|\brate[ -]?limit (?:already )?(?:exceeded|reached|exhausted)\b|\brate limited\b|\babuse detection\b/i;
  const limited = headers.some(({ status, values }) => status === 429 || status === 403 && (values.get("x-ratelimit-remaining") === "0" || rateMessage.test(message)))
    || errors.some((error) => [error?.type, error?.code, error?.extensions?.code].some((code) => code === "RATE_LIMIT" || code === "RATE_LIMITED" || code === "graphql_rate_limit") || rateMessage.test(error?.message ?? ""))
    || result.code !== 0 && (rateMessage.test(`${result.stderr}\n${message}`) || /\bHTTP 429\b/i.test(result.stderr));
  let retryAt = now;
  for (const { values } of headers) {
    const retry = values.get("retry-after");
    if (retry) retryAt = Math.max(retryAt, /^\d+(?:\.\d+)?$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry) || now);
    if (values.get("x-ratelimit-remaining") === "0") retryAt = Math.max(retryAt, Number(values.get("x-ratelimit-reset")) * 1000 || now);
  }
  return { limited, retryAt };
}

/** One cooldown for all GitHub work on this host, including fallback requests.
 * Pollers retry later. Never queue or automatically replay a mutation. */
export function withGitHubBackoff(execute: Run, { now = Date.now, random = Math.random } = {}): Run {
  let failures = 0;
  let retryAt = 0;
  let generation = 0;
  let probing = false;
  const paused = () => new Error(failures ? `GitHub rate limit reached. Requests paused until ${new Date(retryAt).toISOString()}. Cached reviews remain available.` : "GitHub rate limit reached. Refresh to retry.");
  return async (cmd, args, options = {}) => {
    if (cmd !== "gh") return execute(cmd, args, options);
    if (failures && (now() < retryAt || probing)) throw paused();
    const probe = failures > 0;
    if (probe) { probing = true; generation++; }
    const admitted = generation;
    try {
      const api = args[0] === "api";
      const raw = await execute(cmd, api ? ["api", "--include", ...args.slice(1)] : args, { ...options, allowFailure: true });
      const { body, headers } = api ? responseBody(raw.stdout) : { body: raw.stdout, headers: [] };
      const result = { ...raw, stdout: body, ...(headers.length ? { headers } : {}) };
      const limit = limitResponse(result, headers, now());
      if (limit.limited || limit.retryAt > now() && headers.some(({ values }) => values.get("x-ratelimit-remaining") === "0")) {
        // Responses from one concurrent burst share a single backoff step.
        if (admitted === generation) {
          failures = Math.min(failures + 1, 5);
          const delay = Math.min(900_000, 60_000 * 2 ** (failures - 1) * (1 + random() * 0.1));
          retryAt = Math.max(now() + delay, limit.retryAt);
          generation++;
          probing = false;
        } else if (failures) retryAt = Math.max(retryAt, limit.retryAt);
        if (limit.limited) throw paused();
      } else if (probe && admitted === generation && result.code === 0) {
        failures = 0;
        retryAt = 0;
        generation++;
      }
      if (result.code !== 0 && !options.allowFailure) throw new Error(`gh ${args.slice(0, 4).join(" ")}… failed: ${(result.stderr || result.stdout).trim().slice(0, 600)}`);
      return result;
    } finally {
      if ((probe && admitted === generation) || !failures) probing = false;
    }
  };
}
