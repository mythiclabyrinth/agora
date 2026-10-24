import { useEffect, useState } from "react";
import {
  SCHEDULE_FILTERS, scheduleFilterLabel, scheduleFilterCount, filterSchedules, type ScheduleFilter,
  describeSchedule, fmtTs, intervalParts, intervalSeconds, LOST_ACCESS_NOTE, lostChannelAccess, nextRunsLabel,
  SCHEDULES_TRUNCATED_NOTE, sortSchedules, useCancelSchedule, useGroups, useSchedules, useUpdateSchedule,
  type IntervalUnit, type Schedule, type ScheduleSpec,
} from "@agora/core";
import { toast } from "../lib/toast";
import { useUiState } from "../state/ui";
import { Icon } from "../lib/icons";

/* Schedules are created and re-worded by agents acting for their owner;
   people only look, pause/resume, cancel and retime here — so there is no
   "new schedule" form and the message text is read-only. */

const STATUS_LABEL: Record<Schedule["status"], string> = {
  active: "Active", paused: "Paused", done: "Done", cancelled: "Cancelled",
};

type Kind = ScheduleSpec["kind"];

/** `<input type="datetime-local">` value for a unix-second instant, local time. */
function toLocalInput(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): number | null {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
}

/** Only the next time, for an admin managing someone else's schedule: the
    posts go out in the owner's name, so only the owner changes how often. */
function NextRunEditor({ schedule, onDone }: { schedule: Schedule; onDone: () => void }) {
  const update = useUpdateSchedule();
  const initialAt = toLocalInput(schedule.run_at);
  const [at, setAt] = useState(initialAt);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    // Saving the untouched minute would send a time without its seconds.
    if (at === initialAt) { onDone(); return; }
    const t = fromLocalInput(at);
    if (t == null) { setError("Pick a date and time"); return; }
    setError(null);
    update.mutate({ id: schedule.id, change: { run_at: t } }, {
      onSuccess: () => { toast("Schedule updated"); onDone(); },
      onError: e => setError((e as Error).message),
    });
  };
  return (
    <div className="ago-sched-editor">
      <label className="ago-sched-next">Next run
        <input type="datetime-local" aria-label="Next run" value={at} onChange={e => setAt(e.target.value)} />
      </label>
      <span className="dim ago-sched-hint">
        Your local time. Only {schedule.owner_name} can change how often it repeats.
      </span>
      {error && <div className="ago-sched-error" role="alert">{error}</div>}
      <div className="ago-sched-actions">
        <button className="btn sm primary" disabled={update.isPending} onClick={save}>
          {update.isPending ? "Saving…" : "Save"}
        </button>
        <button className="btn sm" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

/** Inline cadence editor; the server validates and computes the next runs. */
function ScheduleEditor({ schedule, onDone }: { schedule: Schedule; onDone: () => void }) {
  const update = useUpdateSchedule();
  const spec = schedule.schedule;
  const [kind, setKind] = useState<Kind>(spec.kind);
  // Pre-fill from the live due time: a re-armed one-off's spec time can lag.
  const initialAt = toLocalInput(schedule.run_at);
  const [at, setAt] = useState(initialAt);
  const initialGap = intervalParts(spec.kind === "interval" ? spec.seconds : 3600);
  const [count, setCount] = useState(String(initialGap.count));
  const [unit, setUnit] = useState<IntervalUnit>(initialGap.unit);
  const [expr, setExpr] = useState(spec.kind === "cron" ? spec.expr : "0 7 * * *");
  // Optional for a repeating schedule: move its next run without touching
  // the rule. Left empty, the server keeps or derives the next run.
  const [nextAt, setNextAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const build = (): ScheduleSpec | string => {
    if (kind === "once") {
      const t = fromLocalInput(at);
      return t == null ? "Pick a date and time" : { kind: "once", at: t };
    }
    if (kind === "interval") {
      const n = Number(count);
      if (!Number.isInteger(n) || n < 1) return "Use a whole number";
      return { kind: "interval", seconds: intervalSeconds(n, unit) };
    }
    return expr.trim() ? { kind: "cron", expr: expr.trim() } : "Enter a cron rule";
  };

  const save = () => {
    const next = build();
    if (typeof next === "string") { setError(next); return; }
    let runAt: number | undefined;
    if (kind !== "once" && nextAt) {
      const t = fromLocalInput(nextAt);
      if (t == null) { setError("Pick a date and time for the next run"); return; }
      if (t <= Date.now() / 1000) { setError("The next run must be in the future"); return; }
      runAt = t;
    }
    // Only send what the person changed: re-sending the stored rule (or the
    // pre-filled minute of a one-off) would restart the clock or drop seconds.
    const sameRule = next.kind === "once"
      ? spec.kind === "once" && at === initialAt
      : next.kind === "interval"
        ? spec.kind === "interval" && spec.seconds === next.seconds
        : spec.kind === "cron" && spec.expr.trim().replace(/\s+/g, " ") === next.expr.replace(/\s+/g, " ");
    const change = { ...(sameRule ? {} : { schedule: next }), ...(runAt != null ? { run_at: runAt } : {}) };
    setError(null);
    if (!Object.keys(change).length) { onDone(); return; }
    update.mutate({ id: schedule.id, change }, {
      onSuccess: () => { toast("Schedule updated"); onDone(); },
      onError: e => setError((e as Error).message),
    });
  };

  return (
    <div className="ago-sched-editor">
      <div className="ago-sched-kinds" role="radiogroup" aria-label="Repeat">
        {(["once", "interval", "cron"] as const).map(k => (
          <label key={k} className={kind === k ? "active" : ""}>
            <input type="radio" name={`kind-${schedule.id}`} checked={kind === k} onChange={() => setKind(k)} />
            {k === "once" ? "Once" : k === "interval" ? "Every" : "Cron"}
          </label>
        ))}
      </div>
      {kind === "once" && (
        <label className="ago-sched-next">Date and time
          <input type="datetime-local" aria-label="Run at" value={at} onChange={e => setAt(e.target.value)} />
        </label>
      )}
      {kind === "interval" && (
        <div className="ago-sched-gap">
          <input type="number" min={1} aria-label="Every" value={count} onChange={e => setCount(e.target.value)} />
          <select aria-label="Unit" value={unit} onChange={e => setUnit(e.target.value as IntervalUnit)}>
            {unit === "seconds" && <option value="seconds">seconds</option>}
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
        </div>
      )}
      {kind === "cron" && (
        <>
          <label className="ago-sched-next">Cron rule · UTC
            <input type="text" aria-label="Cron rule" spellCheck={false} value={expr}
              onChange={e => setExpr(e.target.value)} placeholder="min hour day month weekday" />
          </label>
          <span className="dim ago-sched-hint">
            5 fields, UTC. {expr.trim() && describeSchedule({ kind: "cron", expr: expr.trim() })}
          </span>
        </>
      )}
      {kind !== "once" && (
        <label className="ago-sched-next">
          <span className="dim">Next run (optional, your local time)</span>
          <input type="datetime-local" aria-label="Next run" value={nextAt} onChange={e => setNextAt(e.target.value)} />
        </label>
      )}
      {kind === "once" && <span className="dim ago-sched-hint">Your local time.</span>}
      {kind === "interval" && (
        <span className="dim ago-sched-hint">
          Minimum 5 minutes. {spec.kind === "interval"
            ? "Changing only the length keeps the next run unless it would be later than one new interval from now."
            : "The first run is one interval from now."}
        </span>
      )}
      {error && <div className="ago-sched-error" role="alert">{error}</div>}
      <div className="ago-sched-actions">
        <button className="btn sm primary" disabled={update.isPending} onClick={save}>
          {update.isPending ? "Saving…" : "Save"}
        </button>
        <button className="btn sm" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

/** One schedule; shared by the side pane and the inbox tab. */
export function ScheduleRow({ schedule, showThread, showChannel, onOpen }: {
  schedule: Schedule;
  showThread?: boolean;
  showChannel?: boolean;
  onOpen?: (schedule: Schedule) => void;
}) {
  const update = useUpdateSchedule();
  const cancel = useCancelSchedule();
  const [editing, setEditing] = useState(false);
  const [armed, setArmed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const live = schedule.status === "active" || schedule.status === "paused";
  // The owner lost the channel: it still posts in their name, so they keep
  // ways to stop it (pause or cancel, as the server allows), but nothing that
  // would post into a place they can't see (no resume, no retime).
  const lostAccess = lostChannelAccess(schedule);
  const fail = (what: string) => (e: unknown) =>
    toast(`Couldn't ${what} schedule: ${(e as Error).message}`, { variant: "warn" });
  const setStatus = (status: "paused" | "active") =>
    update.mutate({ id: schedule.id, change: { status } }, { onError: fail(status === "paused" ? "pause" : "resume") });
  const remove = () => {
    if (!armed) { setArmed(true); return; }
    setArmed(false);
    cancel.mutate(schedule, { onSuccess: () => toast("Schedule cancelled"), onError: fail("cancel") });
  };
  const where = [
    showChannel && schedule.channel_name ? `#${schedule.channel_name}` : null,
    showThread && schedule.thread_title ? schedule.thread_title : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className={`ago-sched-row ${schedule.status}`} data-schedule-id={schedule.id}>
      <div className="ago-sched-top">
        <span className="ago-sched-cadence"><Icon name="clock" /> {describeSchedule(schedule.schedule)}</span>
        <span className={`ago-sched-status ${schedule.status}`}>{STATUS_LABEL[schedule.status]}</span>
      </div>
      {where && (
        onOpen
          ? <button className="ago-sched-where" title="Open conversation" onClick={() => onOpen(schedule)}>
              <Icon name={schedule.thread_id != null ? "message-square" : "messages-square"} /> {where}
            </button>
          : <span className="ago-sched-where"><Icon name="message-square" /> {where}</span>
      )}
      <div className={`ago-sched-text ${expanded || schedule.text.length <= 160 ? "expanded" : ""}`}>{schedule.text}</div>
      {schedule.text.length > 160 && <button className="ago-sched-expand" aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Read full message"}</button>}
      <div className="ago-sched-meta">
        {live && schedule.next_runs.length > 0 && (
          <div className="ago-sched-upcoming">
            <span className="ago-sched-next-run">{nextRunsLabel(schedule.status)} {fmtTs(schedule.next_runs[0])}</span>
            {schedule.next_runs.length > 1 && <details className="ago-sched-later">
              <summary>Later runs</summary>
              {schedule.next_runs.slice(1).map((t, i) => <div key={i}>{fmtTs(t)}</div>)}
            </details>}
          </div>
        )}
        {!live && schedule.last_run_at != null && <span>Last ran {fmtTs(schedule.last_run_at)}</span>}
        <span>
          Posts as {schedule.owner_name}
          {schedule.via_agent ? ` · via ${schedule.via_agent}` : ""}
        </span>
      </div>
      {schedule.last_error && <div className="ago-sched-error">{schedule.last_error}</div>}
      {lostAccess && <div className="ago-sched-error">{LOST_ACCESS_NOTE}</div>}
      {lostAccess && schedule.can_manage && live && (
        <div className="ago-sched-actions">
          {schedule.status === "active" &&
            <button className="btn sm" disabled={update.isPending} onClick={() => setStatus("paused")}><Icon name="pause" /> Pause</button>}
          <button className={`btn sm danger ${armed ? "armed" : ""}`} disabled={cancel.isPending}
            title={armed ? "Click again to cancel this schedule" : "Cancel schedule"}
            onBlur={() => setArmed(false)} onClick={remove}>
            <Icon name="trash-2" /> {armed ? "Cancel it?" : "Cancel"}
          </button>
        </div>
      )}
      {!lostAccess && schedule.can_manage && live && !editing && (
        <div className="ago-sched-actions">
          {schedule.status === "active"
            ? <button className="btn sm" disabled={update.isPending} onClick={() => setStatus("paused")}><Icon name="pause" /> Pause</button>
            : <button className="btn sm" disabled={update.isPending} onClick={() => setStatus("active")}><Icon name="play" /> Resume</button>}
          <button className="btn sm" onClick={() => setEditing(true)}><Icon name="pencil" /> Change time</button>
          <button className={`btn sm danger ${armed ? "armed" : ""}`} disabled={cancel.isPending}
            title={armed ? "Click again to cancel this schedule" : "Cancel schedule"}
            onBlur={() => setArmed(false)} onClick={remove}>
            <Icon name="trash-2" /> {armed ? "Cancel it?" : "Cancel"}
          </button>
        </div>
      )}
      {editing && (schedule.is_owner === false
        ? <NextRunEditor schedule={schedule} onDone={() => setEditing(false)} />
        : <ScheduleEditor schedule={schedule} onDone={() => setEditing(false)} />)}
    </div>
  );
}

export function ScheduleFilters({ items, value, onChange }: {
  items: Schedule[]; value: ScheduleFilter; onChange: (value: ScheduleFilter) => void;
}) {
  return <div className="ago-sched-filters" role="tablist" aria-label="Schedule status">
    {SCHEDULE_FILTERS.map((filter, index) => {
      const count = scheduleFilterCount(items, filter);
      return <button key={filter} role="tab" aria-selected={value === filter}
        tabIndex={value === filter ? 0 : -1} onClick={() => onChange(filter)}
        onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3
            : event.key === "Home" ? 0 : event.key === "End" ? 2 : null;
          if (next == null) return;
          event.preventDefault(); onChange(SCHEDULE_FILTERS[next]);
          (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
        }}>
        {scheduleFilterLabel[filter]}{count > 0 && <span className="ago-sched-count">{count.toLocaleString()}</span>}
      </button>;
    })}
  </div>;
}

export function ScheduleEmpty({ filter = "all" }: { filter?: ScheduleFilter }) {
  if (filter !== "all") return <div className="empty ago-sched-empty" role="status"><Icon name="clock" /><strong>No {filter} schedules</strong><span>{filter === "active" ? "Schedules ready to run will appear here." : "Schedules you pause will appear here."}</span></div>;
  return (
    <div className="empty ago-sched-empty">
      <Icon name="clock" />
      <strong>No schedules yet</strong>
      <span>Ask an agent to schedule a message here. It will post as you at the time you choose.</span>
      <span className="ago-sched-example">Try: “Post our daily check here every weekday at 07:00 UTC.”</span>
    </div>
  );
}

export function SchedulesPane() {
  const ui = useUiState();
  const groups = useGroups().data || [];
  const channel = groups.flatMap(g => g.channels || []).find(c => c.id === ui.sel.c);
  const threadId = ui.schedulesThread;
  const q = useSchedules(ui.schedulesOpen ? (channel?.id || "") : "", threadId);
  // Drop a half-armed cancel or open editor when the pane closes.
  const [epoch, setEpoch] = useState(0);
  const [filter, setFilter] = useState<ScheduleFilter>("all");
  useEffect(() => { setFilter("all"); }, [ui.schedulesOpen, channel?.id, threadId]);
  useEffect(() => { if (!ui.schedulesOpen) setEpoch(e => e + 1); }, [ui.schedulesOpen]);
  if (!ui.schedulesOpen || !channel) {
    return <div className="agora-files-pane" style={{ display: "none" }} />;
  }
  const allItems = sortSchedules((q.data?.items || []).filter(s => s.status !== "cancelled"));
  const items = filterSchedules(allItems, filter);
  const open = (schedule: Schedule) => {
    if (schedule.thread_id == null) return;
    // Opening a thread normally closes side panes; here the reader is
    // stepping through schedules, so keep the pane, scoped to that thread.
    ui.openThread(schedule.thread_id, "push");
    ui.setSchedulesOpen(true, schedule.thread_id);
  };
  return (
    <aside className="agora-files-pane ago-sched-pane" aria-label="Schedules" key={epoch}>
      <div className="ago-head">
        <div className="ago-head-text">
          <span className="ago-chan-name">Schedules</span>
          <span className="dim">{threadId == null ? `#${channel.name}` : "this thread"}</span>
        </div>
        <button className="btn sm" title="Close schedules" aria-label="Close schedules" onClick={() => ui.setSchedulesOpen(false)}><Icon name="x" /></button>
      </div>
      <ScheduleFilters items={allItems} value={filter} onChange={setFilter} />
      <div className="ago-files-body">
        {items.map(s => (
          <ScheduleRow key={s.id} schedule={s} showThread={threadId == null} onOpen={threadId == null ? open : undefined} />
        ))}
        {q.isLoading && <div className="empty">Loading schedules…</div>}
        {q.isError && <div className="empty" role="alert">Couldn't load schedules. <button className="btn sm" onClick={() => void q.refetch()}>Retry</button></div>}
        {!q.isLoading && !q.isError && !items.length && <ScheduleEmpty filter={filter} />}
        {q.data?.truncated && <div className="ago-sched-truncated" role="status">{SCHEDULES_TRUNCATED_NOTE}</div>}
      </div>
    </aside>
  );
}
