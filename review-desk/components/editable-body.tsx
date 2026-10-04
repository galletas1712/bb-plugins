import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "./ui/button";

interface EditableBodyProps {
  body: string;
  canEdit: boolean;
  label: string;
  header?: ReactNode;
  allowEmpty?: boolean;
  renderBody(body: string): ReactNode;
  onSave(body: string, expectedBody: string): Promise<{ body: string }>;
  onCancel?(): void;
}

/** Keep a draft and its original text intact through background refreshes. */
export function EditableBody({ body, canEdit, label, header, allowEmpty = false, renderBody, onSave, onCancel }: EditableBodyProps) {
  const [displayBody, setDisplayBody] = useState(body);
  const [edit, setEdit] = useState<{ body: string; original: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDisplayBody(body); }, [body]);
  return (
    <div>
      {header || canEdit ? <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        {header}
        {canEdit && edit === null ? <Button type="button" variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" aria-label={`Edit ${label}`} onClick={() => { setEdit({ body: displayBody, original: displayBody }); setError(null); }}>Edit</Button> : null}
      </div> : null}
      {edit === null ? renderBody(displayBody) : <form className="space-y-2" onSubmit={async (event: FormEvent) => {
        event.preventDefault();
        if (busy || (!allowEmpty && edit.body.trim() === "")) return;
        setBusy(true);
        setError(null);
        try {
          const saved = await onSave(edit.body, edit.original);
          setDisplayBody(saved.body);
          setEdit(null);
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setBusy(false); }
      }}>
        <textarea className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-sans text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" rows={6} value={edit.body} onChange={(event) => setEdit({ ...edit, body: event.target.value })} aria-label={label} maxLength={65_536} disabled={busy} autoFocus />
        {error !== null ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-1.5">
          <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" disabled={busy} onClick={() => { setEdit(null); setError(null); onCancel?.(); }}>Cancel</Button>
          <Button type="submit" size="sm" className="h-7 text-xs" disabled={busy || edit.body === edit.original || (!allowEmpty && edit.body.trim() === "")}>{busy ? "Saving…" : "Save"}</Button>
        </div>
      </form>}
    </div>
  );
}
