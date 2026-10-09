import { ApiError } from "../api/client";

export interface DraftIdentity { server: string; username: string }

export function draftAuthRejected(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

export function draftIdentityChanged(previous: DraftIdentity | null, next: DraftIdentity): boolean {
  return previous !== null && (previous.server !== next.server || previous.username !== next.username);
}
