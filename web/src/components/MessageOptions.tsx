/* Agent-offered choice buttons (meta.options) and their resolved state. */

import { useSelectOption, type Message } from "@agora/core";

export function MessageOptions({ message }: { message: Message }) {
  const select = useSelectOption();
  const meta = message.meta;
  if (!meta || !Array.isArray(meta.options) || !meta.options.length) return null;
  const resolved = meta.resolved && typeof meta.resolved === "object" ? meta.resolved : null;
  if (resolved) {
    const label = resolved.label
      || meta.options.find(o => o.id === resolved.option_id)?.label
      || resolved.option_id
      || "Resolved";
    return (
      <div className="ago-options resolved">
        <span className="ago-option-result">{label}{resolved.by ? ` by ${resolved.by}` : ""}</span>
      </div>
    );
  }
  return (
    <div className="ago-options">
      {meta.options.map(o => (
        <button key={o.id}
          disabled={select.isPending}
          className={`ago-option-btn ${o.style === "primary" ? "primary" : o.style === "danger" ? "danger" : ""}`}
          onClick={() => select.mutate(
            { messageId: message.id, optionId: o.id },
            { onError: (e) => alert((e as Error).message || "Could not submit choice") },
          )}>
          {o.label || o.id}
        </button>
      ))}
    </div>
  );
}
