import { useEffect } from "react";
import { useApi } from "../api/context";
import { useMe } from "../api/queries";
import { draftSync } from "./draftSync";

export function DraftSyncGate() {
  const api = useApi();
  const enabled = useMe().data?.drafts_sync === true;
  useEffect(() => { draftSync.configure(api, enabled); }, [api, enabled]);
  return null;
}
