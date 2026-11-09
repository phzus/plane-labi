/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import { action, computed, makeObservable, observable, runInAction } from "mobx";
// services
import type { TChatMessage, TConversation, TPresenceMember, TSendMessagePayload } from "@/services/messages.service";
import { MessagesService } from "@/services/messages.service";
// store
import type { CoreRootStore } from "./root.store";

export type TMessageThread = { messages: TChatMessage[]; hasMore: boolean; loaded: boolean; loadingOlder: boolean };

type TRealtimeEvent = {
  type: string;
  workspace_slug?: string;
  conversation_id?: string;
  message?: TChatMessage;
  user_id?: string;
  last_read_at?: string;
};

const PANEL_KEY = "labi-messages-panel";

/** Same order as the backend: (created_at, id). */
const byCreatedAt = (a: TChatMessage, b: TChatMessage) =>
  new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** UUID v4 for idempotent sends; crypto.randomUUID needs a secure context, so fall back to getRandomValues. */
const uuid4 = (): string => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

const isSameMessage = (a: TChatMessage, b: TChatMessage) =>
  a.id === b.id || (!!a.client_id && a.client_id === b.client_id);

const activityAt = (c: TConversation) => new Date(c.last_message_at ?? c.created_at).getTime();

const httpStatus = (error: unknown): number | undefined =>
  (error as { response?: { status?: number } })?.response?.status;

export interface IMessagesStore {
  workspaceSlug: string | null;
  conversationMap: Record<string, TConversation>;
  threads: Record<string, TMessageThread>;
  conversationsLoaded: boolean;
  presence: TPresenceMember[];
  panelOpen: boolean;
  panelConversationId: string | null;
  visibleConversationId: string | null;
  sortedConversations: TConversation[];
  unreadConversationsCount: number;
  currentUserId: string | undefined;
  setWorkspace: (slug: string) => void;
  setPanel: (open: boolean, conversationId?: string | null) => void;
  setVisibleConversation: (id: string | null) => void;
  fetchConversations: () => Promise<void>;
  fetchPresence: () => Promise<void>;
  fetchConversation: (id: string) => Promise<TConversation | undefined>;
  fetchLatest: (id: string) => Promise<void>;
  fetchOlder: (id: string) => Promise<void>;
  resync: () => void;
  sendMessage: (id: string, payload: TSendMessagePayload, optimistic: Partial<TChatMessage>) => Promise<void>;
  retryMessage: (id: string, tempId: string) => Promise<void>;
  discardMessage: (id: string, tempId: string) => void;
  deleteMessage: (id: string, messageId: string) => Promise<void>;
  markRead: (id: string) => Promise<void>;
  createConversation: (memberIds: string[], name?: string) => Promise<TConversation>;
  renameConversation: (id: string, name: string) => Promise<void>;
  addMembers: (id: string, memberIds: string[]) => Promise<void>;
  removeMember: (id: string, userId: string) => Promise<void>;
  handleEvent: (event: TRealtimeEvent) => void;
  service: MessagesService;
}

export class MessagesStore implements IMessagesStore {
  workspaceSlug: string | null = null;
  conversationMap: Record<string, TConversation> = {};
  threads: Record<string, TMessageThread> = {};
  conversationsLoaded = false;
  presence: TPresenceMember[] = [];
  panelOpen = false;
  panelConversationId: string | null = null;
  visibleConversationId: string | null = null;
  service = new MessagesService();
  private rootStore: CoreRootStore;

  constructor(rootStore: CoreRootStore) {
    this.rootStore = rootStore;
    try {
      const saved = JSON.parse(sessionStorage.getItem(PANEL_KEY) ?? "null");
      if (saved) {
        this.panelOpen = !!saved.open;
        this.panelConversationId = saved.conversationId ?? null;
      }
    } catch {
      // storage unavailable: start closed
    }
    makeObservable(this, {
      workspaceSlug: observable.ref,
      conversationMap: observable,
      threads: observable,
      conversationsLoaded: observable.ref,
      presence: observable.ref,
      panelOpen: observable.ref,
      panelConversationId: observable.ref,
      visibleConversationId: observable.ref,
      sortedConversations: computed,
      unreadConversationsCount: computed,
      currentUserId: computed,
      setWorkspace: action,
      setPanel: action,
      setVisibleConversation: action,
      discardMessage: action,
      handleEvent: action,
    });
  }

  get currentUserId() {
    return this.rootStore.user.data?.id;
  }

  get sortedConversations() {
    return Object.values(this.conversationMap).sort((a, b) => activityAt(b) - activityAt(a));
  }

  get unreadConversationsCount() {
    return Object.values(this.conversationMap).filter((c) => c.unread_count > 0).length;
  }

  setWorkspace = (slug: string) => {
    if (this.workspaceSlug === slug) return;
    const switching = this.workspaceSlug !== null;
    this.workspaceSlug = slug;
    this.conversationMap = {};
    this.threads = {};
    this.conversationsLoaded = false;
    this.presence = [];
    // A conversation id from another workspace means nothing here (first load keeps the saved panel state).
    if (switching) this.setPanel(this.panelOpen, null);
  };

  setPanel = (open: boolean, conversationId: string | null = this.panelConversationId) => {
    this.panelOpen = open;
    this.panelConversationId = conversationId;
    try {
      sessionStorage.setItem(PANEL_KEY, JSON.stringify({ open, conversationId }));
    } catch {
      // ignore
    }
  };

  setVisibleConversation = (id: string | null) => {
    this.visibleConversationId = id;
  };

  // ---- fetching ---------------------------------------------------------

  fetchConversations = async () => {
    const slug = this.workspaceSlug;
    if (!slug) return;
    const list = await this.service.listConversations(slug);
    runInAction(() => {
      if (slug !== this.workspaceSlug) return;
      this.conversationMap = Object.fromEntries(list.map((c) => [c.id, c]));
      this.conversationsLoaded = true;
    });
  };

  fetchConversation = async (id: string) => {
    const slug = this.workspaceSlug;
    if (!slug) return undefined;
    try {
      const conversation = await this.service.getConversation(slug, id);
      runInAction(() => {
        if (slug === this.workspaceSlug) this.conversationMap[id] = conversation;
      });
      return conversation;
    } catch (error) {
      // 404 = not (or no longer) a member: drop it. Other errors: keep local state, let the caller decide.
      if (httpStatus(error) !== 404) throw error;
      this.dropConversation(id);
      return undefined;
    }
  };

  private dropConversation = action((id: string) => {
    delete this.conversationMap[id];
    delete this.threads[id];
    if (this.panelConversationId === id) this.setPanel(this.panelOpen, null);
  });

  private thread(id: string): TMessageThread {
    if (!this.threads[id]) this.threads[id] = { messages: [], hasMore: false, loaded: false, loadingOlder: false };
    return this.threads[id];
  }

  /**
   * Latest page; merged into what we have so pending messages, older pages and realtime events that
   * arrived while the request was in flight all survive. The thread container exists before the request,
   * so upsertMessage never drops an event for a thread that is loading.
   */
  fetchLatest = async (id: string) => {
    const slug = this.workspaceSlug;
    if (!slug) return;
    runInAction(() => this.thread(id));
    try {
      const { results, has_more } = await this.service.listMessages(slug, id);
      runInAction(() => {
        if (slug !== this.workspaceSlug) return;
        const thread = this.thread(id);
        const pending = thread.messages.filter((m) => m.client_status && !results.some((r) => isSameMessage(r, m)));
        const confirmed = thread.messages.filter((m) => !m.client_status);
        const known = new Set(confirmed.map((m) => m.id));
        const overlaps = results.some((m) => known.has(m.id));
        if (!thread.loaded || !overlaps) {
          const resultIds = new Set(results.map((m) => m.id));
          const lastResult = results[results.length - 1];
          const newer = confirmed.filter(
            (m) => !resultIds.has(m.id) && (!lastResult || byCreatedAt(m, lastResult) > 0)
          );
          thread.messages = [...results, ...newer.sort(byCreatedAt), ...pending];
          thread.hasMore = has_more;
        } else {
          const fresh = new Map(results.map((m) => [m.id, m]));
          const merged = confirmed.map((m) => fresh.get(m.id) ?? m);
          const added = results.filter((m) => !known.has(m.id));
          thread.messages = [...[...merged, ...added].sort(byCreatedAt), ...pending];
        }
        thread.loaded = true;
      });
    } catch (error) {
      if (httpStatus(error) === 404) this.dropConversation(id);
    }
  };

  fetchOlder = async (id: string) => {
    const slug = this.workspaceSlug;
    const thread = this.threads[id];
    if (!slug || !thread || !thread.hasMore || thread.loadingOlder) return;
    const oldest = thread.messages.find((m) => !m.client_status);
    if (!oldest) return;
    runInAction(() => (thread.loadingOlder = true));
    try {
      const { results, has_more } = await this.service.listMessages(slug, id, oldest.id);
      runInAction(() => {
        if (slug !== this.workspaceSlug) return;
        const known = new Set(thread.messages.map((m) => m.id));
        thread.messages = [...results.filter((m) => !known.has(m.id)), ...thread.messages];
        thread.hasMore = has_more;
      });
    } finally {
      runInAction(() => (thread.loadingOlder = false));
    }
  };

  /** The socket is best-effort: after (re)connect or tab focus, refetch from the source of truth. */
  fetchPresence = async () => {
    const slug = this.workspaceSlug;
    if (!slug) return;
    try {
      const presence = await this.service.getPresence(slug);
      if (slug === this.workspaceSlug) runInAction(() => (this.presence = presence));
    } catch {
      // guests get 403 and transient errors keep the last known list
    }
  };

  private presenceTimer: ReturnType<typeof setTimeout> | undefined;

  resync = () => {
    void this.fetchPresence();
    void this.fetchConversations().catch(() => undefined);
    if (this.visibleConversationId) void this.fetchLatest(this.visibleConversationId);
  };

  // ---- messages ------------------------------------------------------------

  private upsertMessage = action((message: TChatMessage) => {
    const conversation = this.conversationMap[message.conversation_id];
    if (conversation) {
      const isNewer = !conversation.last_message || byCreatedAt(conversation.last_message, message) <= 0;
      if (isNewer) {
        conversation.last_message = message;
        conversation.last_message_at = message.created_at;
      }
    }
    // No container = nobody is looking at this thread; it is fetched fresh when opened.
    const thread = this.threads[message.conversation_id];
    if (!thread) return false;
    const index = thread.messages.findIndex((m) => !m.client_status && m.id === message.id);
    if (index >= 0) {
      thread.messages[index] = message;
      return false;
    }
    // My own message echoed back (realtime or retry): replaces its optimistic copy, matched by client_id.
    const confirmed = thread.messages.filter((m) => !m.client_status);
    const pending = thread.messages.filter((m) => m.client_status && !isSameMessage(message, m));
    thread.messages = [...[...confirmed, message].sort(byCreatedAt), ...pending];
    return true;
  });

  sendMessage = async (id: string, payload: TSendMessagePayload, optimistic: Partial<TChatMessage>) => {
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const clientId = uuid4();
    payload = { ...payload, client_id: clientId };
    runInAction(() => {
      this.thread(id).messages.push({
        id: tempId,
        conversation_id: id,
        sender_id: this.currentUserId ?? null,
        body: payload.body ?? "",
        is_removed: false,
        reply_to: null,
        attachments: [],
        created_at: new Date().toISOString(),
        ...optimistic,
        client_id: clientId,
        client_status: "pending",
        client_payload: payload,
      });
    });
    await this.deliver(id, tempId);
  };

  /** Re-sends the same payload (same client_id), so the server returns the original if the first try landed. */
  retryMessage = async (id: string, tempId: string) => {
    const message = this.threads[id]?.messages.find((m) => m.id === tempId);
    if (!message) return;
    runInAction(() => {
      message.client_status = "pending";
      message.client_error_status = undefined;
    });
    await this.deliver(id, tempId);
  };

  discardMessage = (id: string, tempId: string) => {
    const thread = this.threads[id];
    if (thread) thread.messages = thread.messages.filter((m) => m.id !== tempId);
  };

  private deliver = async (id: string, tempId: string) => {
    const slug = this.workspaceSlug;
    const temp = this.threads[id]?.messages.find((m) => m.id === tempId);
    if (!slug || !temp?.client_payload) return;
    try {
      const saved = await this.service.sendMessage(slug, id, temp.client_payload);
      runInAction(() => {
        this.discardMessage(id, tempId);
        // The realtime echo or a resync may have arrived first: upsert dedupes by id / client_id.
        this.upsertMessage(saved);
        const me = this.conversationMap[id]?.members.find((m) => m.id === this.currentUserId);
        if (me) me.last_read_at = saved.created_at;
      });
    } catch (error) {
      // Shown inline under the bubble (with "Tentar de novo"), so no toast.
      runInAction(() => {
        temp.client_status = "failed";
        temp.client_error_status = httpStatus(error);
      });
    }
  };

  deleteMessage = async (id: string, messageId: string) => {
    if (!this.workspaceSlug) return;
    const updated = await this.service.deleteMessage(this.workspaceSlug, id, messageId);
    this.upsertMessage(updated);
  };

  markRead = async (id: string) => {
    if (!this.workspaceSlug) return;
    const { last_read_at } = await this.service.markRead(this.workspaceSlug, id);
    runInAction(() => {
      const conversation = this.conversationMap[id];
      if (!conversation) return;
      conversation.unread_count = 0;
      const me = conversation.members.find((m) => m.id === this.currentUserId);
      if (me) me.last_read_at = last_read_at;
    });
  };

  // ---- conversations ---------------------------------------------------------

  createConversation = async (memberIds: string[], name?: string) => {
    const slug = this.workspaceSlug;
    if (!slug) throw new Error("No workspace");
    const conversation = await this.service.createConversation(slug, {
      member_ids: memberIds,
      ...(name ? { name } : {}),
    });
    runInAction(() => (this.conversationMap[conversation.id] = conversation));
    return conversation;
  };

  renameConversation = async (id: string, name: string) => {
    if (!this.workspaceSlug) return;
    const conversation = await this.service.renameConversation(this.workspaceSlug, id, name);
    runInAction(() => (this.conversationMap[id] = conversation));
  };

  addMembers = async (id: string, memberIds: string[]) => {
    if (!this.workspaceSlug) return;
    const conversation = await this.service.addMembers(this.workspaceSlug, id, memberIds);
    runInAction(() => (this.conversationMap[id] = conversation));
  };

  removeMember = async (id: string, userId: string) => {
    if (!this.workspaceSlug) return;
    await this.service.removeMember(this.workspaceSlug, id, userId);
    if (userId === this.currentUserId) this.dropConversation(id);
    else await this.fetchConversation(id);
  };

  // ---- realtime -----------------------------------------------------------------

  handleEvent = (event: TRealtimeEvent) => {
    if (event.type === "presence.changed") {
      // Several people can connect at once: one fetch per burst is enough.
      clearTimeout(this.presenceTimer);
      this.presenceTimer = setTimeout(() => void this.fetchPresence(), 1000);
      return;
    }
    const id = event.conversation_id;
    if (!id || event.workspace_slug !== this.workspaceSlug) return;
    switch (event.type) {
      case "message.created":
      case "message.updated": {
        if (!event.message) return;
        if (!this.conversationMap[id]) {
          void this.fetchConversation(id).catch(() => undefined);
          return;
        }
        const hasThread = !!this.threads[id];
        const inserted = this.upsertMessage(event.message);
        const fromOther = event.message.sender_id !== this.currentUserId;
        // The visible conversation view marks it read right after (debounced).
        if (event.type === "message.created" && fromOther && (inserted || !hasThread))
          this.conversationMap[id].unread_count += 1;
        return;
      }
      case "conversation.created":
      case "conversation.updated":
        void this.fetchConversation(id).catch(() => undefined);
        return;
      case "conversation.read": {
        const conversation = this.conversationMap[id];
        if (!conversation || !event.user_id || !event.last_read_at) return;
        const member = conversation.members.find((m) => m.id === event.user_id);
        if (member) member.last_read_at = event.last_read_at;
        if (event.user_id === this.currentUserId) conversation.unread_count = 0;
        return;
      }
    }
  };
}
