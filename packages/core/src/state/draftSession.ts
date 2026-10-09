export interface DraftIdentity { server: string; username: string }

export function draftIdentityChanged(previous: DraftIdentity | null, next: DraftIdentity): boolean {
  return previous !== null && (previous.server !== next.server || previous.username !== next.username);
}
