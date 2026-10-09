export function ReplyingIndicator({ names }: { names: string[] }) {
  if (!names.length) return null;
  const label = `${names.join(", ")} ${names.length === 1 ? "is" : "are"} replying`;
  return <span className="ago-replying" role="img" aria-label={label} title={label}>
    <span /><span /><span />
  </span>;
}
