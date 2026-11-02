// Roundtable shares a transcript across participant threads.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import {
  definePluginApp,
  Markdown,
  ThreadChat,
  useBbNavigate,
  useRealtime,
  useRpc,
  experimental_FileLink as FileLink,
  experimental_useAppPanel as useAppPanel,
  experimental_useFixedTabTarget as useFixedTabTarget,
  type ExperimentalPluginFixedTabReference,
  type JsonValue,
} from "@get-bb/plugin-sdk/app";
import type {
  ContextOptions,
  Job,
  Message,
  Participant,
  ParticipantInput,
  RoomDetail,
  RoomSummary,
  rpcContract,
} from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Contract = typeof rpcContract;

const PANEL_ID = "rooms";
const PANEL_PATH = "rooms";
const ROOM_CHANGED = "room-changed";
const MAX_TURNS = 40;

interface AgentTabTarget {
  threadId: string;
  [key: string]: JsonValue;
}
function hasStringField(value: JsonValue, field: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)[field] === "string"
  );
}
const AGENT_TAB: ExperimentalPluginFixedTabReference<AgentTabTarget> = {
  panelId: PANEL_ID,
  id: "agent-thread",
  experimental_target: { validate: (value): value is AgentTabTarget => hasStringField(value, "threadId") },
};
// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function roomIdOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const id = (payload as { roomId?: unknown }).roomId;
  return typeof id === "string" ? id : null;
}

function useRooms() {
  const rpc = useRpc<Contract>();
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("rooms_list").then(
      (result) => {
        setRooms(result.rooms);
        setError(null);
      },
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(ROOM_CHANGED, refetch);
  return { rooms, error, refetch };
}

function useRoom(roomId: string | null) {
  const rpc = useRpc<Contract>();
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    if (roomId === null) return;
    rpc.call("rooms_get", { roomId }).then(
      (result) => {
        setDetail(result);
        setError(null);
      },
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc, roomId]);
  useEffect(() => {
    setDetail(null);
    setError(null);
    refetch();
  }, [refetch]);
  useRealtime(ROOM_CHANGED, (payload) => {
    const changed = roomIdOf(payload);
    if (changed === null || changed === roomId) refetch();
  });
  // Status changes inside a participant thread are not all published; poll
  // slowly while anything is running so the busy dots stay honest.
  const busy =
    detail?.participants.some((p) => !p.removed && isRunning(p.status)) ||
    (detail?.job !== null && detail?.job !== undefined);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(refetch, 4000);
    return () => clearInterval(timer);
  }, [busy, refetch]);
  return { rpc, detail, error, refetch };
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function isRunning(status: string | null): boolean {
  return status === "active" || status === "starting" || status === "pending";
}

function StatusDot({ status }: { status: string | null }) {
  if (isRunning(status)) return <Icon name="Loading" className="size-3 shrink-0 animate-spin text-primary" aria-label="Working" />;
  return (
    <span
      aria-hidden
      className={cn("inline-block size-1.5 shrink-0 rounded-full", status === "error" ? "bg-destructive" : "bg-muted-foreground/40")}
    />
  );
}

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function clampTurns(value: number): number {
  return Math.min(MAX_TURNS, Math.max(0, Number.isFinite(value) ? Math.round(value) : 0));
}

interface ParticipantChipProps {
  participant: Participant;
  selected: boolean;
  isDocOwner: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onToggleEdit: () => void;
  onCompact: () => void;
  onReset: () => void;
  onRemove: () => void;
}

function ParticipantChip({ participant, selected, isDocOwner, onToggle, onOpen, onToggleEdit, onCompact, onReset, onRemove }: ParticipantChipProps) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent | globalThis.KeyboardEvent) => {
      const menu = menuRef.current;
      if (!menu?.open) return;
      if (event instanceof globalThis.KeyboardEvent) {
        if (event.key === "Escape") {
          menu.open = false;
          menu.querySelector("summary")?.focus();
        }
      } else if (!menu.contains(event.target as Node)) menu.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  const action = (fn: () => void) => () => {
    if (menuRef.current) menuRef.current.open = false;
    fn();
  };
  return (
    <div className="relative inline-flex items-center rounded-full border border-border text-xs">
      <button type="button" aria-pressed={selected} onClick={onToggle}
        className={cn("inline-flex items-center gap-2 rounded-l-full px-3 py-1.5 hover:bg-state-hover", selected && "bg-foreground text-background hover:bg-foreground/90")}>
        <StatusDot status={participant.status} />
        @{participant.handle}
      </button>
      <details ref={menuRef} className="relative">
        <summary aria-label={"Actions for @" + participant.handle} className="flex cursor-pointer list-none rounded-r-full p-1.5 text-muted-foreground hover:bg-state-hover [&::-webkit-details-marker]:hidden">
          <Icon name="MoreHorizontal" className="size-4" />
        </summary>
        <div className="absolute right-0 top-full z-20 mt-2 w-56 rounded-md border border-border bg-card p-1 shadow-md">
          <div className="space-y-1 px-2 py-2 text-muted-foreground">
            <p>{participant.providerId}</p>
            {participant.model ? <p>{participant.model}</p> : null}
            <p>{participant.canEdit ? "Can edit files" : isDocOwner ? "Can edit the pinned document" : "Read-only"}</p>
          </div>
          <MenuItem label="Open thread" disabled={participant.threadId === null} onClick={action(onOpen)} />
          <MenuItem label={participant.canEdit ? "Make read-only" : "Allow file edits"} onClick={action(onToggleEdit)} />
          <MenuItem label="Compact context" disabled={participant.threadId === null} onClick={action(onCompact)} />
          <MenuItem label="Restart with room history" disabled={participant.threadId === null} onClick={action(onReset)} />
          <MenuItem label="Remove" destructive onClick={action(onRemove)} />
        </div>
      </details>
    </div>
  );
}

function MenuItem({ label, onClick, disabled, destructive }: { label: string; onClick: () => void; disabled?: boolean; destructive?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={cn("block w-full rounded px-2 py-1.5 text-left hover:bg-state-hover disabled:opacity-40", destructive && "text-destructive")}>
      {label}
    </button>
  );
}

function CopyMessage({ text }: { text: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (status === "idle") return;
    const timer = setTimeout(() => setStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [status]);
  return <>
    <button type="button" aria-label={status === "copied" ? "Copied" : "Copy message"}
      title={status === "copied" ? "Copied" : "Copy message"}
      className="rounded p-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setStatus("copied");
        } catch {
          setStatus("error");
        }
      }}>
      <Icon name={status === "copied" ? "Check" : "Copy"} className="size-3.5" />
    </button>
    <span role="status" className={status === "error" ? "text-destructive" : "sr-only"}>
      {status === "copied" ? "Message copied" : status === "error" ? "Couldn't copy. Try again." : ""}
    </span>
  </>;
}

function MessageRow({ message }: { message: Message }) {
  const isUser = message.author === "user";
  if (message.author === "system") {
    return <li className="py-2 text-center text-xs text-muted-foreground">{message.text}</li>;
  }
  return (
    <li className={cn("flex flex-col gap-2 py-4", isUser && "items-end")} id={"msg-" + message.seq}>
      <div className="flex items-center gap-3 text-xs">
        <span className="font-medium">{isUser ? "You" : "@" + message.author}</span>
        <time dateTime={new Date(message.createdAt).toISOString()} className="text-muted-foreground">{timeLabel(message.createdAt)}</time>
        {!isUser ? <CopyMessage text={message.body + (message.openPoints.length ? "\n\nOpen points\n" + message.openPoints.map((point, index) => `${index + 1}. ${point}`).join("\n") : "")} /> : null}
      </div>
      <div className={cn("max-w-full text-sm sm:max-w-[90%]", isUser && "rounded-lg bg-foreground/5 px-3 py-2")}>
        <Markdown content={message.body} />
        {message.openPoints.length > 0 ? (
          <details open={message.stance === "need-info"} className="mt-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">Open points ({message.openPoints.length})</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              {message.openPoints.map((point, index) => <li key={index}>{point}</li>)}
            </ol>
          </details>
        ) : null}
      </div>
    </li>
  );
}

function JobBanner({ job, onStop, onResume, disabled }: { job: NonNullable<Job>; onStop: () => void; onResume: () => void; disabled: boolean }) {
  const text = job.paused
    ? `Paused. @${job.paused.handle} needs input: ${job.paused.question}`
    : `Turn ${job.turn} of ${job.totalTurns}${job.current ? `: @${job.current} is responding` : ""}`;
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border bg-card px-4 py-2 text-xs">
      {job.paused ? (
        <Icon name="Pause" className="size-3.5 text-muted-foreground" />
      ) : (
        <Icon name="Loading" className="size-3.5 animate-spin text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">{text}</span>
      {job.paused ? (
        <Button variant="outline" size="sm" onClick={onResume} disabled={disabled}>
          <Icon name="Play" className="size-3.5" />
          Resume
        </Button>
      ) : null}
      <Button variant="outline" size="sm" onClick={onStop} disabled={disabled}>
        <Icon name="Square" className="size-3.5" />
        Stop
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Room settings and participant forms
// ---------------------------------------------------------------------------

const selectClass =
  "h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function RoomSettings({ detail, onDone }: { detail: RoomDetail; onDone: () => void }) {
  const rpc = useRpc<Contract>();
  const [title, setTitle] = useState(detail.room.title);
  const [docPath, setDocPath] = useState(detail.room.docPath ?? "");
  const [docOwner, setDocOwner] = useState(detail.room.docOwner ?? "");
  const [turns, setTurns] = useState(Math.max(2, detail.room.defaultTurns));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const handles = detail.participants.filter((p) => !p.removed).map((p) => p.handle);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await rpc.call("rooms_update", {
        roomId: detail.room.id,
        title: title.trim(),
        docPath: docPath.trim() === "" ? null : docPath.trim(),
        docOwner: docOwner === "" ? null : docOwner,
        defaultTurns: turns,
      });
      onDone();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-2 border-b border-border bg-card px-4 py-2 text-xs">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-muted-foreground">
          Title
          <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-8 w-56 text-xs" required />
        </label>
        <label className="flex flex-col gap-1 text-muted-foreground">
          Pinned document (workspace path)
          <Input value={docPath} onChange={(e) => setDocPath(e.target.value)} placeholder=".roundtable/plan.md" className="h-8 w-56 text-xs" />
        </label>
        <label className="flex flex-col gap-1 text-muted-foreground">
          Document owner
          <select value={docOwner} onChange={(e) => setDocOwner(e.target.value)} className={selectClass} disabled={docPath.trim() === ""}>
            <option value="">you</option>
            {handles.map((h) => (
              <option key={h} value={h}>@{h}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-muted-foreground">
          Discussion turn limit
          <Input type="number" min={2} max={MAX_TURNS} value={turns} onChange={(e) => setTurns(Math.max(2, clampTurns(Number(e.target.value))))} className="h-8 w-16 text-xs" />
        </label>
        <Button type="submit" size="sm" disabled={pending || title.trim() === ""}>Save</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        {error ? <span role="alert" className="text-destructive">{error}</span> : null}
      </div>
    </form>
  );
}

interface SeatDraft {
  handle: string;
  providerId: string;
  model: string;
  reasoningLevel: string;
  canEdit: boolean;
}

function toParticipantInput(seat: SeatDraft): ParticipantInput {
  return {
    handle: seat.handle.trim().toLowerCase(),
    providerId: seat.providerId,
    ...(seat.model ? { model: seat.model } : {}),
    ...(seat.reasoningLevel ? { reasoningLevel: seat.reasoningLevel as ParticipantInput["reasoningLevel"] } : {}),
    canEdit: seat.canEdit,
  };
}

function SeatEditor({ seat, options, onChange, onRemove }: { seat: SeatDraft; options: ContextOptions; onChange: (patch: Partial<SeatDraft>) => void; onRemove?: () => void }) {
  const provider = options.providers.find((p) => p.id === seat.providerId);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2">
      <span className="text-xs text-muted-foreground">@</span>
      <Input
        value={seat.handle}
        onChange={(e) => onChange({ handle: e.target.value })}
        placeholder="handle"
        pattern="[a-z][a-z0-9-]{0,23}"
        title="lowercase letters, digits, dashes"
        required
        className="h-8 w-28 text-xs"
        aria-label="Handle"
      />
      <select value={seat.providerId} onChange={(e) => onChange({ providerId: e.target.value, model: "", reasoningLevel: "" })} className={selectClass} aria-label="Provider">
        {options.providers.map((p) => (
          <option key={p.id} value={p.id} disabled={!p.available}>
            {p.displayName}{p.available ? "" : " (unavailable)"}
          </option>
        ))}
      </select>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">Model options</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <select value={seat.model} onChange={(e) => onChange({ model: e.target.value })} className={selectClass} aria-label="Model">
            <option value="">Default model</option>
            {(provider?.models ?? []).map((m) => <option key={m.model} value={m.model}>{m.displayName}</option>)}
          </select>
          {(provider?.reasoningLevels.length ?? 0) > 0 ? (
            <select value={seat.reasoningLevel} onChange={(e) => onChange({ reasoningLevel: e.target.value })} className={selectClass} aria-label="Reasoning">
              <option value="">Default reasoning</option>
              {(provider?.reasoningLevels ?? []).filter((level) => ["low", "medium", "high", "xhigh", "max"].includes(level)).map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          ) : null}
        </div>
      </details>
      <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title="Read-only seats may inspect the workspace but not change it">
        <input type="checkbox" checked={seat.canEdit} onChange={(e) => onChange({ canEdit: e.target.checked })} className="size-3.5" />
        may edit files
      </label>
      {onRemove ? (
        <Button type="button" variant="ghost" size="icon" className="ml-auto size-7 text-muted-foreground hover:text-foreground" aria-label="Remove seat" onClick={onRemove}>
          <Icon name="Trash2" className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}

function AddParticipantForm({ detail, options, onDone }: { detail: RoomDetail; options: ContextOptions; onDone: () => void }) {
  const rpc = useRpc<Contract>();
  const first = options.providers.find((p) => p.available) ?? options.providers[0];
  const [seat, setSeat] = useState<SeatDraft>({ handle: "", providerId: first?.id ?? "", model: "", reasoningLevel: "", canEdit: false });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await rpc.call("rooms_add_participant", {
        roomId: detail.room.id,
        participant: toParticipantInput(seat),
      });
      onDone();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-2 border-b border-border bg-card px-4 py-2 text-xs">
      <SeatEditor seat={seat} options={options} onChange={(patch) => setSeat((s) => ({ ...s, ...patch }))} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending || seat.handle.trim() === ""}>
          <Icon name="UserRoundPlus" className="size-3.5" />
          Add
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        {error ? <span role="alert" className="text-destructive">{error}</span> : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Room view
// ---------------------------------------------------------------------------

function parseMentions(text: string, handles: readonly string[]): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(^|[^a-z0-9])@([a-z][a-z0-9-]*)/gi)) {
    const handle = match[2].toLowerCase();
    if (handles.includes(handle)) found.add(handle);
  }
  return [...found];
}

type PendingAction = "send" | "discuss" | "resume" | "halt" | "archive" | "participant" | null;

function RoomView({ roomId, compact = false }: { roomId: string; compact?: boolean }) {
  const { rpc, detail, error, refetch } = useRoom(roomId);
  const navigate = useBbNavigate();
  const panel = useAppPanel();
  const [text, setText] = useState("");
  const [tagged, setTagged] = useState<string[]>([]);
  const [mode, setMode] = useState<"reply" | "discuss">("reply");
  const [turns, setTurns] = useState<number | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [options, setOptions] = useState<ContextOptions | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const active = useMemo(() => detail?.participants.filter((p) => !p.removed) ?? [], [detail]);
  const handles = useMemo(() => active.map((p) => p.handle), [active]);
  const mentioned = useMemo(() => parseMentions(text, handles), [text, handles]);
  const tags = useMemo(() => [...new Set([...tagged, ...mentioned])], [tagged, mentioned]);
  const effectiveTurns = turns ?? detail?.room.defaultTurns ?? 4;

  useEffect(() => {
    if (showAdd && options === null) {
      rpc.call("context_options").then(setOptions, (cause: unknown) => setActionError(describeError(cause)));
    }
  }, [showAdd, options, rpc]);

  const messageCount = detail?.messages.length ?? 0;
  useEffect(() => {
    const el = listRef.current;
    if (el === null || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messageCount, detail?.job?.current]);

  const onScroll = () => {
    const el = listRef.current;
    if (el === null) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const run = async (action: NonNullable<PendingAction>, fn: () => Promise<unknown>) => {
    if (pendingAction !== null) return;
    setPendingAction(action);
    setActionError(null);
    try {
      await fn();
    } catch (cause) {
      setActionError(describeError(cause));
    } finally {
      setPendingAction(null);
    }
  };

  const afterSend = () => {
    setText("");
    setTagged([]);
    stickToBottom.current = true;
    refetch();
  };

  const send = () =>
    run("send", async () => {
      const body = text.trim();
      if (body === "") return;
      await rpc.call("rooms_post", { roomId, text: body, tags, turns: 0 });
      afterSend();
    });

  const discuss = () =>
    run("discuss", async () => {
      const body = text.trim();
      if (body === "" || tags.length < 2) return;
      await rpc.call("rooms_discuss", { roomId, text: body, participants: tags, turns: Math.max(2, effectiveTurns) });
      afterSend();
    });

  const resumeJob = () => run("resume", () => rpc.call("rooms_resume_job", { roomId }));
  const halt = () =>
    run("halt", async () => {
      await rpc.call("rooms_halt", { roomId });
      refetch();
    });

  const archive = () =>
    run("archive", async () => {
      if (!window.confirm("Archive this room and stop its participant threads?")) return;
      await rpc.call("rooms_archive", { roomId });
      if (!compact) navigate.toPluginPanel(PANEL_PATH, { replace: true });
    });

  const participantAction = (fn: () => Promise<unknown>) => run("participant", async () => { await fn(); refetch(); });

  const submitMessage = () => {
    if (mode === "discuss" && detail?.job === null) void discuss();
    else void send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submitMessage();
    }
  };

  const openThread = (participant: Participant) => {
    if (participant.threadId === null) return;
    const accepted = compact
      ? false
      : panel.openFixedTab({ surface: { kind: "current" }, tab: AGENT_TAB, target: { threadId: participant.threadId } });
    if (!accepted) navigate.toThread(participant.threadId);
  };

  if (error !== null) {
    return (
      <div className="p-4">
        <p role="alert" className="text-sm text-destructive">{error}</p>
      </div>
    );
  }
  if (detail === null) {
    return (
      <div className="p-4">
        <EmptyState>Loading room…</EmptyState>
      </div>
    );
  }

  const job = detail.job;
  const canSend = text.trim() !== "" && pendingAction === null;
  const working = active.filter((p) => isRunning(p.status));
  const anyRunning = job !== null || working.length > 0;
  const docTarget = detail.room.docPath !== null && detail.room.environmentId !== null
    ? { kind: "workspace" as const, environmentId: detail.room.environmentId, path: detail.room.docPath }
    : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        {!compact ? (
          <Button variant="ghost" size="sm" className="md:hidden" onClick={() => navigate.toPluginPanel(PANEL_PATH)}>
            Rooms
          </Button>
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{detail.room.title}</h2>
          {!compact ? (
            <p className="truncate text-xs text-muted-foreground">
              {detail.workspacePath ?? "Workspace resolves when the first participant is tagged"}
            </p>
          ) : null}
        </div>
        {docTarget ? (
          <FileLink target={docTarget} className="inline-flex max-w-56 items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
            <Icon name="FileText" className="size-3.5 shrink-0" />
            <span className="truncate">{detail.room.docPath?.split("/").pop()}</span>
          </FileLink>
        ) : null}
        {anyRunning && job === null ? (
          <Button variant="outline" size="sm" onClick={halt} disabled={pendingAction !== null} aria-label="Stop all running seats and drop pending relays">
            <Icon name="Square" className="size-3.5" />
            Stop
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => { setShowSettings((v) => !v); setShowAdd(false); }} aria-label="Room settings" aria-pressed={showSettings}>
          <Icon name="Settings" className="size-4" />
        </Button>
        {compact ? (
          <Button variant="ghost" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: roomId })} aria-label="Open the full room page">
            <Icon name="ExternalLink" className="size-4" />
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={archive} disabled={pendingAction !== null} aria-label="Archive room">
            <Icon name="Archive" className="size-4" />
          </Button>
        )}
      </header>

      {showSettings ? <RoomSettings detail={detail} onDone={() => { setShowSettings(false); refetch(); }} /> : null}

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
        {active.map((participant) => (
          <ParticipantChip
            key={participant.handle}
            participant={participant}
            selected={tags.includes(participant.handle)}
            isDocOwner={detail.room.docOwner === participant.handle}
            onToggle={() =>
              setTagged((current) =>
                current.includes(participant.handle) ? current.filter((h) => h !== participant.handle) : [...current, participant.handle],
              )
            }
            onOpen={() => openThread(participant)}
            onToggleEdit={() => participantAction(() => rpc.call("rooms_participant_update", { roomId, handle: participant.handle, canEdit: !participant.canEdit }))}
            onCompact={() => participantAction(() => rpc.call("rooms_participant_compact", { roomId, handle: participant.handle }))}
            onReset={() => {
              if (!window.confirm("Restart @" + participant.handle + " with the room history?")) return;
              void participantAction(() => rpc.call("rooms_participant_reset", { roomId, handle: participant.handle }));
            }}
            onRemove={() => {
              if (!window.confirm(`Remove @${participant.handle} from the room and stop its thread?`)) return;
              void participantAction(() => rpc.call("rooms_participant_remove", { roomId, handle: participant.handle }));
            }}
          />
        ))}
        <button
          type="button"
          onClick={() => { setShowAdd((v) => !v); setShowSettings(false); }}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground"
          aria-expanded={showAdd}
        >
          <Icon name="UserRoundPlus" className="size-3.5" />
          Add
        </button>
      </div>

      {showAdd && options !== null ? <AddParticipantForm detail={detail} options={options} onDone={() => { setShowAdd(false); refetch(); }} /> : null}


      <div ref={listRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4">
        {detail.messages.length === 0 ? (
          <div className="py-6">
            <EmptyState>
              Choose a participant or type @name to start.
            </EmptyState>
          </div>
        ) : (
          <ul className="mx-auto w-full max-w-3xl divide-y divide-border/60">
            {detail.messages.map((message) => (
              <MessageRow key={message.seq} message={message} />
            ))}
            {working.length > 0 ? (
              <li role="status" className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
                <Icon name="Loading" className="size-3.5 animate-spin" />
                {working.map((p) => "@" + p.handle).join(", ")} responding…
              </li>
            ) : null}
          </ul>
        )}
      </div>

      {job !== null ? <JobBanner job={job} onStop={halt} onResume={resumeJob} disabled={pendingAction !== null} /> : null}

      <form
        className="border-t border-border px-4 py-3"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          submitMessage();
        }}
      >
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder={job?.paused ? "Answer @" + job.paused.handle + "…" : "Message the room…"}
          aria-label="Message"
          className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {job === null ? (
            <select value={mode} onChange={(event) => setMode(event.target.value as "reply" | "discuss")} className={selectClass} aria-label="Conversation mode">
              <option value="reply">Ask for replies</option>
              <option value="discuss">Discuss together</option>
            </select>
          ) : null}
          {mode === "discuss" && job === null ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Turn limit
              <Input type="number" min={2} max={MAX_TURNS} value={Math.max(2, effectiveTurns)}
                onChange={(event) => setTurns(Math.max(2, clampTurns(Number(event.target.value))))} className="h-8 w-16 text-xs" />
            </label>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {job?.paused ? "Your reply resumes the discussion." : mode === "discuss" && job === null && tags.length < 2 ? "Choose at least two participants." : tags.length === 0 ? "A note for the room." : ""}
          </span>
          <Button type="submit" size="sm" className="ml-auto" disabled={!canSend || (mode === "discuss" && job === null && tags.length < 2)}>
            {mode === "discuss" && job === null ? "Start discussion" : "Send"}
          </Button>
        </div>
        {actionError !== null ? <p role="alert" className="mt-2 text-xs text-destructive">{actionError}</p> : null}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create room
// ---------------------------------------------------------------------------

interface CreatePreset {
  projectId: string;
  environmentId: string | null;
  title: string;
}

function defaultSeats(options: ContextOptions): SeatDraft[] {
  const available = options.providers.filter((p) => p.available);
  const has = (id: string) => available.some((p) => p.id === id);
  const seats: SeatDraft[] = [];
  const seat = (handle: string, providerId: string, canEdit: boolean): SeatDraft => ({ handle, providerId, model: "", reasoningLevel: "", canEdit });
  if (has("claude-code")) seats.push(seat("claude", "claude-code", false));
  if (has("codex")) seats.push(seat("codex", "codex", false));
  const acp = available.find((p) => p.id.startsWith("acp-") && p.models.length > 0) ?? available.find((p) => p.id.startsWith("acp-"));
  if (acp) seats.push(seat(acp.id.replace(/^acp-/, ""), acp.id, true));
  if (seats.length === 0 && available[0]) seats.push(seat(available[0].id.replace(/[^a-z0-9-]/g, ""), available[0].id, false));
  return seats;
}

function CreateRoomForm({ preset, onCreated }: { preset?: CreatePreset; onCreated?: (roomId: string) => void }) {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const [options, setOptions] = useState<ContextOptions | null>(null);
  const [title, setTitle] = useState(preset?.title ?? "");
  const [projectId, setProjectId] = useState(preset?.projectId ?? "");
  const [seats, setSeats] = useState<SeatDraft[]>([]);
  const [docPath, setDocPath] = useState("");
  const [docOwner, setDocOwner] = useState("");
  const [turns, setTurns] = useState(4);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    rpc.call("context_options").then(
      (result) => {
        setOptions(result);
        const defaults = defaultSeats(result);
        setSeats(defaults);
        setDocOwner(defaults[0]?.handle ?? "");
        const personal = result.projects.find((p) => p.kind !== "standard");
        setProjectId((current) => current || personal?.id || result.projects[0]?.id || "");
      },
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc]);

  const update = (index: number, patch: Partial<SeatDraft>) => setSeats((current) => current.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || options === null) return;
    setPending(true);
    setError(null);
    try {
      const { room } = await rpc.call("rooms_create", {
        title: title.trim(),
        projectId,
        environmentId: preset?.environmentId ?? null,
        participants: seats.map(toParticipantInput),
        docPath: docPath.trim() === "" ? null : docPath.trim(),
        docOwner: docPath.trim() === "" || docOwner === "" ? null : docOwner,
        defaultTurns: turns,
      });
      if (onCreated) onCreated(room.id);
      else navigate.toPluginPanel(PANEL_PATH, { subPath: room.id, replace: true });
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setPending(false);
    }
  };

  if (options === null) {
    return (
      <div className="p-4">
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <EmptyState>Loading providers…</EmptyState>}
      </div>
    );
  }

  const handles = seats.map((s) => s.handle.trim().toLowerCase()).filter((h) => h !== "");

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 md:p-5">
      <form onSubmit={submit} className="mx-auto w-full max-w-3xl space-y-4">
        <div>
          <h2 className="text-sm font-semibold">New room</h2>
          <p className="text-xs text-muted-foreground">Choose who joins the conversation.</p>
        </div>
        <label className="block space-y-1 text-xs text-muted-foreground">
          Title
          <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Plan review: session indexer" required />
        </label>
        {preset?.environmentId ? null : (
          <label className="block space-y-1 text-xs text-muted-foreground">
            Project
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className={cn(selectClass, "block h-9 w-full")}>
              {options.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}{project.kind !== "standard" ? " (personal)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Participants</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                const first = options.providers.find((p) => p.available) ?? options.providers[0];
                if (!first) return;
                setSeats((current) => [...current, { handle: "", providerId: first.id, model: "", reasoningLevel: "", canEdit: false }]);
              }}
            >
              <Icon name="Plus" className="size-4" />
              Add participant
            </Button>
          </div>
          <div className="space-y-2">
            {seats.map((seat, index) => (
              <SeatEditor key={index} seat={seat} options={options} onChange={(patch) => update(index, patch)} onRemove={() => setSeats((current) => current.filter((_, i) => i !== index))} />
            ))}
          </div>
        </div>

        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Room options</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block space-y-1 text-xs text-muted-foreground sm:col-span-2">
            Pinned document (workspace path, optional)
            <Input value={docPath} onChange={(event) => setDocPath(event.target.value)} placeholder=".roundtable/plan.md" />
          </label>
          <label className="block space-y-1 text-xs text-muted-foreground">
            Document owner
            <select value={docOwner} onChange={(event) => setDocOwner(event.target.value)} className={cn(selectClass, "block h-9 w-full")} disabled={docPath.trim() === ""}>
              <option value="">you</option>
              {handles.map((h) => (
                <option key={h} value={h}>@{h}</option>
              ))}
            </select>
          </label>
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            Discussion turn limit
            <Input type="number" min={2} max={MAX_TURNS} value={turns} onChange={(event) => setTurns(Math.max(2, clampTurns(Number(event.target.value))))} className="h-8 w-16 text-xs" />
          </label>
        </details>

        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={pending || seats.length === 0 || title.trim() === "" || projectId === ""}>
            <Icon name="MessageSquarePlus" className="size-4" />
            Create room
          </Button>
          {onCreated ? null : (
            <Button type="button" variant="ghost" onClick={() => navigate.toPluginPanel(PANEL_PATH, { replace: true })}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page, tabs, thread panel
// ---------------------------------------------------------------------------

function RoomListItem({ room, active, onSelect }: { room: RoomSummary; active: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
        className={cn("w-full rounded-md px-2.5 py-2 text-left hover:bg-state-hover", active && "bg-state-active")}
      >
        <div className="flex items-center gap-1.5 truncate text-sm font-medium">
          {room.discussing ? <Icon name="Loading" className="size-3 animate-spin text-muted-foreground" /> : null}
          {room.title}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {room.handles.map((h) => `@${h}`).join(", ")}
        </div>
      </button>
    </li>
  );
}

function RoundtablePage({ subPath }: { subPath: string }) {
  const { rooms, error } = useRooms();
  const navigate = useBbNavigate();
  const [head] = subPath.split("/");
  const creating = head === "new";
  const roomId = !creating && head !== "" ? head : null;

  return (
    <div className="flex h-full min-h-0">
      <aside className={cn("flex w-52 shrink-0 flex-col border-r border-border", (roomId !== null || creating) && "hidden md:flex")}>
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-xs font-medium text-muted-foreground">Rooms</span>
          <Button variant="ghost" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "new" })}>
            <Icon name="Plus" className="size-4" />
            New
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {error ? (
            <p role="alert" className="px-2 text-xs text-destructive">{error}</p>
          ) : rooms === null ? (
            <p className="px-2 text-xs text-muted-foreground">Loading…</p>
          ) : rooms.length === 0 ? (
            <p className="px-2 text-xs text-muted-foreground">No rooms yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {rooms.map((room) => (
                <RoomListItem key={room.id} room={room} active={room.id === roomId} onSelect={() => navigate.toPluginPanel(PANEL_PATH, { subPath: room.id })} />
              ))}
            </ul>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        {creating ? (
          <CreateRoomForm />
        ) : roomId !== null ? (
          <RoomView key={roomId} roomId={roomId} />
        ) : (
          <div className="p-6">
            <EmptyState>
              Choose a room to continue, or start a new conversation.
            </EmptyState>
          </div>
        )}
      </main>
    </div>
  );
}

function AgentThreadTab() {
  const target = useFixedTabTarget(AGENT_TAB);
  if (target === null) {
    return (
      <div className="p-4">
        <EmptyState>Click the panel icon next to a participant to open its thread here.</EmptyState>
      </div>
    );
  }
  return <ThreadChat key={target.target.threadId} threadId={target.target.threadId} variant="compact" layout="contained" className="h-full" />;
}

function ThreadRoomPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<Contract>();
  const [state, setState] = useState<{ roomId: string | null; preset: CreatePreset } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("rooms_for_thread", { threadId }).then(
      (result) =>
        setState({
          roomId: result.room?.id ?? null,
          preset: { projectId: result.projectId, environmentId: result.environmentId, title: result.title },
        }),
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc, threadId]);
  if (error) {
    return (
      <div className="p-4">
        <p role="alert" className="text-sm text-destructive">{error}</p>
      </div>
    );
  }
  if (state === null) {
    return (
      <div className="p-4">
        <EmptyState>Looking for a room in this workspace…</EmptyState>
      </div>
    );
  }
  if (state.roomId === null) {
    return <CreateRoomForm preset={state.preset} onCreated={(roomId) => setState({ ...state, roomId })} />;
  }
  return <RoomView key={state.roomId} roomId={state.roomId} compact />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: PANEL_ID,
    title: "Roundtable",
    icon: "MessageSquare",
    path: PANEL_PATH,
    component: RoundtablePage,
    fixedTabs: [
      { ...AGENT_TAB, title: "Agent thread", icon: "Bot", layout: "flush", component: AgentThreadTab },
    ],
  });
  app.slots.threadPanelAction({
    id: "room",
    title: "Roundtable room",
    icon: "MessageSquare",
    layout: "flush",
    component: ThreadRoomPanel,
  });
});
