/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { observer } from "mobx-react";
import { ArrowLeft, Settings2 } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";
import { useMessages } from "@/hooks/store/use-messages";
import type { TChatMessage, TConversation } from "@/services/messages.service";
import { Composer } from "./composer";
import { ConversationAvatar } from "./conversation-avatar";
import { GroupSettingsModal } from "./group-settings-modal";
import { conversationTitle, onlineOthers, otherMembers, presenceLabel, useMinuteTick } from "./helpers";
import { MessageLog } from "./message-log";

export const headerIconButton =
  "grid size-8 pointer-coarse:size-10 flex-shrink-0 place-items-center rounded-full text-secondary hover:bg-layer-transparent-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-strong";

type Props = {
  conversationId: string;
  onBack?: () => void;
  backClassName?: string;
  /** Extra header buttons (expand / close in the floating panel). */
  actions?: ReactNode;
  /** Called after the user leaves the group or the conversation disappears. */
  onGone: () => void;
};

/** Line under the title: "Online há 2 min" (direct) or "5 membros · 2 online" (group). */
const ConversationStatus = observer(function ConversationStatus(props: { conversation: TConversation; meId?: string }) {
  const { conversation, meId } = props;
  const { t } = useTranslation();
  const { presenceById } = useMessages();
  useMinuteTick();
  const online = onlineOthers(conversation, meId, presenceById);
  const label =
    conversation.kind === "group"
      ? [
          t("labi_messages.members_count", { count: conversation.members.length }),
          online > 0 ? t("labi_messages.group_online", { count: online }) : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : presenceLabel(presenceById.get(otherMembers(conversation, meId)[0]?.id ?? ""), t);
  return <span className="truncate text-11 text-tertiary">{label}</span>;
});

export const ConversationView = observer(function ConversationView(props: Props) {
  const { conversationId, onBack, backClassName, actions, onGone } = props;
  const { t } = useTranslation();
  const store = useMessages();
  const conversation = store.conversationMap[conversationId];
  const [replyTo, setReplyTo] = useState<TChatMessage | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const unread = conversation?.unread_count ?? 0;
  const unreadRef = useRef(unread);
  unreadRef.current = unread;
  const markedFor = useRef<string | null>(null);

  // Register as the visible conversation (for resync) and load its latest page.
  useEffect(() => {
    store.setVisibleConversation(conversationId);
    void store.fetchLatest(conversationId);
    setReplyTo(null);
    return () => store.setVisibleConversation(null);
  }, [conversationId, store]);

  // Unknown id (e.g. deep link before the list loads, or a brand-new conversation): fetch it.
  const listLoaded = store.conversationsLoaded;
  useEffect(() => {
    if (!conversation && listLoaded) {
      void store
        .fetchConversation(conversationId)
        .then((c) => !c && onGone())
        .catch(() => undefined);
    }
  }, [conversation, conversationId, listLoaded, store, onGone]);

  // Mark as read on open and on new incoming messages, only while the tab is visible and focused.
  useEffect(() => {
    const mark = () => {
      // Always once per open; afterwards only when something is unread.
      if (markedFor.current === conversationId && unreadRef.current === 0) return;
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      markedFor.current = conversationId;
      void store.markRead(conversationId).catch(() => undefined);
    };
    const timer = window.setTimeout(mark, 1000);
    window.addEventListener("focus", mark);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", mark);
    };
  }, [conversationId, store, unread]);

  if (!conversation)
    return (
      <div className="flex flex-1 items-center justify-center text-13 text-tertiary">{t("labi_messages.loading")}</div>
    );

  const meId = store.currentUserId;
  const title = conversationTitle(conversation, meId);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-subtle px-2 py-2">
        {onBack && (
          <button
            type="button"
            className={cn(headerIconButton, backClassName)}
            onClick={onBack}
            aria-label={t("labi_messages.back")}
            title={t("labi_messages.back")}
          >
            <ArrowLeft className="size-4" />
          </button>
        )}
        <ConversationAvatar
          conversation={conversation}
          meId={meId}
          size={32}
          online={onlineOthers(conversation, meId, store.presenceById) > 0}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate text-13 font-semibold text-primary">{title}</h2>
          <ConversationStatus conversation={conversation} meId={meId} />
        </div>
        {conversation.kind === "group" && (
          <button
            type="button"
            className={headerIconButton}
            onClick={() => setSettingsOpen(true)}
            aria-label={t("labi_messages.group_options")}
            title={t("labi_messages.group_options")}
          >
            <Settings2 className="size-4" />
          </button>
        )}
        {actions}
      </div>
      <MessageLog key={conversation.id} conversation={conversation} onReply={setReplyTo} />
      <Composer
        key={`composer-${conversation.id}`}
        conversation={conversation}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
      />
      {conversation.kind === "group" && (
        <GroupSettingsModal
          conversation={conversation}
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onLeft={onGone}
        />
      )}
    </div>
  );
});
