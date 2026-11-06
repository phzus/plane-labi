/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import { useEffect } from "react";
import { LIVE_BASE_PATH, LIVE_BASE_URL } from "@plane/constants";
import type { IMessagesStore } from "@/store/messages.store";

const MIN_DELAY = 1000;
const MAX_DELAY = 30000;
const AUTH_CLOSE_CODES = new Set([4401, 4403]);

const messagesSocketUrl = () => {
  // Same construction as the collaboration socket in pages/editor/editor-body.tsx.
  const url = new URL(LIVE_BASE_URL?.trim() || window.location.origin);
  url.protocol = window.location.protocol === "https:" ? "wss" : "ws";
  url.pathname = `${LIVE_BASE_PATH}/messages/`;
  return url.toString();
};

/**
 * One push-only WebSocket per tab. Auth is the session cookie (same origin).
 * The socket is best-effort: every (re)connect and every return to the tab triggers a resync over HTTP.
 */
export const useMessagesRealtime = (store: IMessagesStore, enabled: boolean) => {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    let socket: WebSocket | null = null;
    let attempt = 0;
    let timer: number | undefined;
    let stopped = false;
    let lastResync = 0;

    const scheduleReconnect = () => {
      const base = Math.min(MAX_DELAY, MIN_DELAY * 2 ** attempt);
      attempt += 1;
      timer = window.setTimeout(connect, base / 2 + Math.random() * (base / 2));
    };

    function connect() {
      if (stopped) return;
      try {
        socket = new WebSocket(messagesSocketUrl());
      } catch {
        scheduleReconnect();
        return;
      }
      socket.addEventListener("message", (event) => {
        let data: { type?: string };
        try {
          data = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (data.type === "ready") {
          attempt = 0;
          store.resync();
        } else if (data.type) {
          store.handleEvent(data as Parameters<IMessagesStore["handleEvent"]>[0]);
        }
      });
      socket.addEventListener("close", (event) => {
        socket = null;
        // 4401 session invalid / 4403 origin refused: retrying won't help. Wait for the user to come back
        // to the tab (visibility/focus), which retries once with a fresh backoff.
        if (!stopped && !AUTH_CLOSE_CODES.has(event.code)) scheduleReconnect();
      });
    }

    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (!socket) {
        // Reconnect now (also after a 4401/4403 stop); "ready" triggers the resync.
        window.clearTimeout(timer);
        attempt = 0;
        connect();
      } else if (Date.now() - lastResync > 5000) {
        // visibilitychange and focus usually fire together: one resync per 5s is enough.
        lastResync = Date.now();
        store.resync();
      }
    };

    connect();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
      socket?.close();
    };
  }, [store, enabled]);
};
