/* Interactive tables (meta.table). Shared cell state lives in
   meta.table_state; typing stays a local draft until Enter / the check icon
   confirms it. A row action locks only that row; a table-level button locks
   every still-unlocked row via meta.table_submitted. */

import { useState } from "react";
import {
  useActOnTableRow,
  useSubmitTable,
  useUpdateTableCell,
  fmtTs,
  type Message,
  type MessageTableColumn,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";

function cellKey(rowId: string, colId: string) {
  return `${rowId}:${colId}`;
}

function displayValue(v: string | number | undefined): string {
  if (v === undefined || v === null) return "";
  return String(v);
}

function parseCommitValue(col: MessageTableColumn, draft: string): string | number {
  if (col.kind === "number") {
    const trimmed = draft.trim();
    if (trimmed === "") return "";
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : draft;
  }
  return draft;
}

export function MessageTableView({ message }: { message: Message }) {
  const update = useUpdateTableCell();
  const act = useActOnTableRow();
  const submit = useSubmitTable();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const meta = message.meta;
  const table = meta?.table && typeof meta.table === "object" ? meta.table : null;
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) return null;
  const state = meta?.table_state && typeof meta.table_state === "object" ? meta.table_state : {};
  const rowLocks = meta?.table_rows && typeof meta.table_rows === "object" ? meta.table_rows : {};
  const tableDone = meta?.table_submitted && typeof meta.table_submitted === "object"
    ? meta.table_submitted : null;
  const buttons = Array.isArray(table.buttons) ? table.buttons : [];
  const tableLocked = !!tableDone;

  const confirmCell = (rowId: string, col: MessageTableColumn) => {
    const key = cellKey(rowId, col.id);
    const draft = drafts[key];
    if (draft === undefined) return;
    update.mutate(
      { messageId: message.id, rowId, columnId: col.id, value: parseCommitValue(col, draft) },
      {
        onSuccess: () => setDrafts(d => { const n = { ...d }; delete n[key]; return n; }),
        onError: (e) => toast("Couldn't save: " + (e as Error).message, { variant: "warn" }),
      },
    );
  };

  const flushDrafts = async (rowId?: string) => {
    const candidates = Object.entries(drafts).filter(([key]) =>
      rowId ? key.startsWith(`${rowId}:`) : true,
    );
    // Locked-row drafts can never persist (409); drop them so they don't
    // abort a table-level submit while still flushing unlocked cells.
    const stale: string[] = [];
    const pending: [string, string][] = [];
    for (const [key, draft] of candidates) {
      const rid = key.split(":")[0];
      if (rid && rowLocks[rid]) {
        stale.push(key);
        continue;
      }
      pending.push([key, draft]);
    }
    for (const [key, draft] of pending) {
      const [rid, colId] = key.split(":");
      const col = table.columns.find(c => c.id === colId);
      if (!rid || !col) continue;
      await update.mutateAsync({
        messageId: message.id,
        rowId: rid,
        columnId: col.id,
        value: parseCommitValue(col, draft),
      });
    }
    setDrafts(d => {
      const next = { ...d };
      for (const [key] of pending) delete next[key];
      for (const key of stale) delete next[key];
      return next;
    });
  };

  const pressRow = (rowId: string, actionId: string) => {
    // Keep the pressed button enabled for styling, but don't re-POST.
    if (busy || tableLocked || !!rowLocks[rowId]) return;
    setBusy(true);
    void (async () => {
      try {
        await flushDrafts(rowId);
        await act.mutateAsync({ messageId: message.id, rowId, actionId });
      } catch (e) {
        toast("Action failed: " + (e as Error).message, { variant: "warn" });
      } finally {
        setBusy(false);
      }
    })();
  };

  const pressTable = (buttonId: string) => {
    if (busy || tableLocked) return;
    setBusy(true);
    void (async () => {
      try {
        await flushDrafts();
        await submit.mutateAsync({ messageId: message.id, buttonId });
      } catch (e) {
        toast("Submit failed: " + (e as Error).message, { variant: "warn" });
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className={`ago-table ${tableLocked ? "submitted" : ""}`}>
      <div className="ago-table-scroll">
        <table>
          <thead>
            <tr>
              {table.columns.map(c => (
                <th key={c.id} style={c.width ? { width: c.width, minWidth: c.width } : undefined}>
                  {c.label}
                </th>
              ))}
              <th className="ago-table-actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map(row => {
              const lock = rowLocks[row.id];
              const rowLocked = !!lock || tableLocked;
              const values = lock?.values
                || (tableDone?.rows && tableDone.rows[row.id])
                || state[row.id]
                || row.cells
                || {};
              return (
                <tr key={row.id} className={rowLocked ? "locked" : undefined}>
                  {table.columns.map(col => {
                    const server = displayValue(values[col.id]);
                    if (rowLocked || col.kind === "readonly") {
                      return <td key={col.id} className={col.kind === "readonly" ? "ro" : undefined}>{server || "—"}</td>;
                    }
                    const key = cellKey(row.id, col.id);
                    const draft = drafts[key];
                    const dirty = draft !== undefined && draft !== server;
                    return (
                      <td key={col.id}>
                        <span className="ago-table-inwrap">
                          <input
                            className="ago-table-input"
                            type={col.kind === "number" ? "number" : "text"}
                            maxLength={2000}
                            aria-label={`${row.id} ${col.label}`}
                            value={dirty || draft !== undefined ? draft : server}
                            onChange={e => setDrafts(d => ({ ...d, [key]: e.target.value }))}
                            onKeyDown={e => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                confirmCell(row.id, col);
                              }
                            }}
                          />
                          <button
                            className={`ago-form-confirm ${dirty ? "dirty" : ""}`}
                            title="Save this value for everyone"
                            onClick={() => confirmCell(row.id, col)}
                          >
                            <Icon name="check" />
                          </button>
                        </span>
                      </td>
                    );
                  })}
                  <td className="ago-table-actions-col">
                    <div className="ago-table-row-actions">
                      {(row.actions || []).map(a => {
                        const pressed = lock?.action_id === a.id;
                        return (
                          <button
                            key={a.id}
                            className={`ago-option-btn ${a.style === "primary" ? "primary" : "secondary"}${pressed ? " pressed" : ""}`}
                            disabled={busy || tableLocked || (!!lock && !pressed)}
                            onClick={() => pressRow(row.id, a.id)}
                          >
                            {a.label || a.id}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {buttons.length > 0 && (
        <div className="ago-table-actions">
          {buttons.map(b => {
            const pressed = tableDone?.button_id === b.id;
            return (
              <button
                key={b.id}
                className={`ago-option-btn ${b.style === "primary" ? "primary" : "secondary"}${pressed ? " pressed" : ""}`}
                disabled={busy || (tableLocked && !pressed)}
                onClick={() => pressTable(b.id)}
              >
                {b.label || b.id}
              </button>
            );
          })}
          {tableDone && (
            <span className="ago-table-done dim">
              by {tableDone.by || "?"}{tableDone.ts ? ` · ${fmtTs(tableDone.ts)}` : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
