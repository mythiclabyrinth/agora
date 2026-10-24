/* A header tool's text. Inline (wide header) it stays short; inside the ⋯
   menu it uses the same wording and subtitle as the mobile app's sheet
   (mobile/src/lib/conversationTools.ts) so the three surfaces read alike. */
export function HeaderToolLabel({ menu, label, menuLabel, detail }: {
  menu: boolean;
  label: string;
  menuLabel?: string;
  detail?: string;
}) {
  if (!menu) return <span className="ago-btn-label">{label}</span>;
  return (
    <span className="ago-menu-text">
      <span className="ago-menu-main ago-btn-label">{menuLabel ?? label}</span>
      {detail && <span className="ago-menu-detail">{detail}</span>}
    </span>
  );
}
