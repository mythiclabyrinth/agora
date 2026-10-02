/* The section-navigation dot rail (.ago-section-rail): a vertical column of
   clickable dots pinned to the right edge of a message log. One dot per
   conversational section — a user message plus the group of agent replies
   that follow it, until the next user message (a leading agent group with no
   preceding user message is its own section too). The dot for the section
   currently in view is highlighted; clicking a dot scrolls that section to
   the top. Shared by the channel log (MessageLog) and the thread pane. */

import { useEffect, useMemo, useState } from "react";
import { agentRailColors, conversationSections, useAgents, type Message } from "@agora/core";

const ACTIVE_OFFSET_PX = 80; // a section counts as "in view" once its top passes this
const AT_BOTTOM_PX = 8;

export function SectionRail({ boxRef, messages }: {
  boxRef: React.RefObject<HTMLDivElement | null>;
  messages: Message[];
}) {
  const agents = useAgents().data;
  const agentColors = useMemo(() => agentRailColors(agents || []), [agents]);
  const sections = useMemo(() => conversationSections(messages, agentColors), [messages, agentColors]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || sections.length < 2) return;
    let raf = 0;
    const recompute = () => {
      raf = 0;
      const mark = box.scrollTop + ACTIVE_OFFSET_PX;
      let idx = 0;
      for (let i = 0; i < sections.length; i++) {
        const el = box.querySelector<HTMLElement>(`[data-mid="${sections[i].mid}"]`);
        if (!el) continue;
        if (el.offsetTop <= mark) idx = i; else break;
      }
      // At the very bottom the last section is the one being read.
      if (box.scrollHeight - box.scrollTop - box.clientHeight < AT_BOTTOM_PX) {
        idx = sections.length - 1;
      }
      setActive(idx);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(recompute); };
    box.addEventListener("scroll", onScroll, { passive: true });
    recompute();
    return () => {
      box.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [boxRef, sections]);

  if (sections.length < 2) return null;

  const jump = (mid: number) => {
    const box = boxRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-mid="${mid}"]`);
    if (box && el) box.scrollTo({ top: Math.max(0, el.offsetTop - 12), behavior: "smooth" });
  };

  return (
    <div className="ago-section-rail" role="navigation" aria-label="Jump to a section of the conversation">
      {sections.map((s, i) => (
        <button key={s.mid} type="button"
          className={`ago-rail-dot ${s.agentId ? "agent" : ""} ${i === active ? "active" : ""}`}
          style={s.agentId ? { "--rail-c": agentColors.get(s.agentId) } as React.CSSProperties : undefined}
          title={s.label} aria-label={`Jump to: ${s.label}${s.agentId ? " (agent)" : ""}`}
          aria-current={i === active ? "true" : undefined}
          onClick={() => jump(s.mid)} />
      ))}
    </div>
  );
}
