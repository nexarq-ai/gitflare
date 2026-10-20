import { useCallback, useEffect, useRef, useState } from "react";
import type { InboxView, NotificationList } from "../shared/notifications";
import { request } from "./api";

export interface InboxCounts { work: number; unread: number }

const POLL_MS = 120_000;
const ROUTE_REFRESH_MS = 20_000;

export function useInboxCounts(enabled: boolean, workspaceId: string, route: string): [InboxCounts | null, (counts: Partial<InboxCounts>) => void] {
  const [counts, setCounts] = useState<InboxCounts | null>(null);
  const fetchedAt = useRef(0);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    fetchedAt.current = Date.now();
    try {
      const [work, notifications] = await Promise.all([request<InboxView>("/api/inbox?limit=1"), request<NotificationList>("/api/notifications?filter=unread&limit=1")]);
      if (current === generation.current) setCounts({ work: work.total, unread: notifications.unread });
    } catch {
      if (current === generation.current) setCounts(null);
    }
  }, []);

  useEffect(() => {
    if (!enabled) { setCounts(null); return; }
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, workspaceId, refresh]);

  useEffect(() => {
    if (enabled && Date.now() - fetchedAt.current > ROUTE_REFRESH_MS) void refresh();
  }, [route]);

  const update = useCallback((next: Partial<InboxCounts>) => {
    generation.current++;
    fetchedAt.current = Date.now();
    setCounts(current => ({ work: next.work ?? current?.work ?? 0, unread: next.unread ?? current?.unread ?? 0 }));
  }, []);

  return [counts, update];
}
