// Pure prompt construction and reply parsing for the title model.

export interface OutlineItem {
  role: "user" | "assistant";
  preview: string;
}

export interface TitlePrompt {
  system: string;
  user: string;
}

/** Transcript budget sent to the model, in characters (~1.5k tokens). */
export const DIGEST_BUDGET_CHARS = 6000;
export const TITLE_MAX_CHARS = 45;

const SHARED_RULES = `Rules:
- Return exactly one JSON object and no other text: {"reason":"...","title":...}. Write "reason" first, in at most 15 words.
- Base the title on the conversation's central goal and durable subject matter across all turns, not just the latest message.
- When the conversation keeps returning to a named code module, plugin, package, service, crate, file, or component, the title must contain that name exactly as written (for example "provider-codex", "session_titles.rs", "Knowledge plugin", "review-desk").
- Use sentence case, 3-7 words, at most ${TITLE_MAX_CHARS} characters, in the user's language.
- No quotation marks, no trailing punctuation, no generic prefixes such as "Chat about".
- Never include secrets, tokens, API keys, or credentials.`;

const INITIAL_SYSTEM = `You name coding-agent chat sessions. The session has no title yet. Read the conversation and write a short title for it.

${SHARED_RULES}
- Set "title" to the new title, or to null when the conversation is empty, unclear, or mostly a credential.`;

const REFRESH_SYSTEM = `You maintain the title of a coding-agent chat session. Decide whether the current title still fits the conversation.

${SHARED_RULES}
- Default to "title": null, which keeps the current title.
- Set "title" to a new title only when the session's overall topic has durably shifted or expanded beyond the current title, when the current title omits the main module the work is about, or when it is cut off mid-phrase.
- Do not rename for follow-ups, corrections, status checks, interruptions, single task steps, PR numbers, or implementation details within the same overall topic.`;

/**
 * Renders the conversation outline as a bounded transcript. The first user
 * message always survives because it usually states the session's goal. The
 * rest is filled newest-first until the budget runs out.
 */
export function renderDigest(
  items: readonly OutlineItem[],
  budget = DIGEST_BUDGET_CHARS,
): string {
  const lines = items
    .map((item) => {
      const text = item.preview.replace(/\s+/gu, " ").trim();
      return text ? `${item.role === "user" ? "User" : "Assistant"}: ${text}` : null;
    })
    .filter((line): line is string => line !== null);
  if (lines.length === 0) return "";

  const firstUser = lines.findIndex((line) => line.startsWith("User: "));
  const pinned = firstUser === -1 ? null : lines[firstUser]!;
  let remaining = budget - (pinned?.length ?? 0);
  const recent: string[] = [];
  for (let i = lines.length - 1; i > firstUser; i--) {
    const line = lines[i]!;
    if (line.length + 1 > remaining) break;
    recent.unshift(line);
    remaining -= line.length + 1;
  }

  const omitted = lines.length - recent.length - (pinned ? 1 : 0);
  return [
    ...(pinned ? [pinned] : []),
    ...(omitted > 0 ? [`[${omitted} messages omitted]`] : []),
    ...recent,
  ].join("\n");
}

export function buildTitlePrompt(
  currentTitle: string | null,
  items: readonly OutlineItem[],
): TitlePrompt | null {
  const digest = renderDigest(items);
  if (!digest) return null;
  // A missing or over-long title always gets a fresh one.
  const fresh = currentTitle === null || currentTitle.length > TITLE_MAX_CHARS;
  return {
    system: fresh ? INITIAL_SYSTEM : REFRESH_SYSTEM,
    user: [
      ...(fresh ? [] : [`Current title: ${currentTitle}`, ""]),
      "Conversation (oldest first, each message truncated):",
      digest,
    ].join("\n"),
  };
}

/** Extracts `{"title": ...}` from the model reply. Null means keep the title. */
export function parseTitleReply(reply: string): string | null {
  const match = /\{[\s\S]*\}/u.exec(reply);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const raw = (parsed as { title?: unknown }).title;
  return typeof raw === "string" ? sanitizeTitle(raw) : null;
}

const DANGLING_TAIL = /(?:[\s,;:/&+-]+(?:and|or|for|to|of|in|on|with|from|by|the|a|an|via|vs))*[\s,;:/&+-]*$/iu;

export function sanitizeTitle(raw: string): string | null {
  let title = raw
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/gu, "")
    .trim();
  if (title.length > TITLE_MAX_CHARS) {
    const cut = title.slice(0, TITLE_MAX_CHARS + 1);
    const space = cut.lastIndexOf(" ");
    title = space > 0 ? cut.slice(0, space) : title.slice(0, TITLE_MAX_CHARS);
    // A cut can strand a connector, as in "Rewrite PR descriptions and".
    title = title.replace(DANGLING_TAIL, "");
  }
  title = title.replace(/[\s.!?:;,]+$/u, "");
  if (!title || looksLikeSecret(title)) return null;
  return title;
}

function looksLikeSecret(value: string): boolean {
  const lower = value.toLowerCase();
  if (/\bsk-[a-z0-9]/u.test(lower) || lower.includes("bearer ")) return true;
  return /(api_?key|access_token|secret|token|passw(or)?d)\s*[:=]/u.test(lower);
}
