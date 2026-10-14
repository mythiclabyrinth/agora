/* Notification navigation only dedupes the screen already on top. Different
   targets deliberately push so replacing a screen never destroys its draft.
   A same-target tap with no message stays inert even when the viewer is
   scrolled above the newest message; with a message it hands the id to the
   screen already on top, whose landing owns the scrolling. */

export type NotificationNavigationAction = "none" | "push" | "land";

export function notificationNavigationAction({
  pathname,
  target,
  messageId = null,
}: {
  pathname: string;
  target: string;
  messageId?: number | null;
}): NotificationNavigationAction {
  if (target !== pathname) return "push";
  return messageId == null ? "none" : "land";
}

/** The route param carrying a per-tap token next to `messageId`. Setting the
    same messageId again changes nothing, so a repeated tap for one message
    would not re-land without it. */
export const LAND_NONCE_PARAM = "landAt";

/** Params that re-target the conversation already on top: `tap` must be
    unique per tap. */
export function notificationLandParams(messageId: number, tap: string): Record<string, string> {
  return { messageId: String(messageId), [LAND_NONCE_PARAM]: tap };
}

/** The pushed href: the conversation route, landing on the notified message
    when the payload names one. */
export function notificationHref(target: string, messageId: number | null): string {
  return messageId == null ? target : `${target}?messageId=${messageId}`;
}
