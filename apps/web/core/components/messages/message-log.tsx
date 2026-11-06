/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { ArrowDown } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { AlertModalCore } from "@plane/ui";
import { useMessages } from "@/hooks/store/use-messages";
import type { TChatMessage, TConversation } from "@/services/messages.service";
import {
  apiErrorMessage,
  conversationTitle,
  needsSeparator,
  otherMembers,
  relativeTime,
  separatorLabel,
  useMinuteTick,
} from "./helpers";
import { MessageBubble } from "./message-bubble";

/** Mount with key={conversation.id} so scroll state resets per conversation. */
type Props = { conversation: TConversation; onReply: (message: TChatMessage) => void };

const BOTTOM_SLACK = 48;

export const MessageLog = observer(function MessageLog({ conversation, onReply }: Props) {
  const { t, currentLocale } = useTranslation();
  const store = useMessages();
  const meId = store.currentUserId;
  const thread = store.threads[conversation.id];
  const messages = thread?.messages ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevHeight = useRef(0);
  const prevFirstId = useRef<string | undefined>(undefined);
  const prevLastId = useRef<string | undefined>(undefined);
  const [showNewChip, setShowNewChip] = useState(false);
  const [deleting, setDeleting] = useState<TChatMessage | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const firstId = messages[0]?.id;
  const last = messages[messages.length - 1];

  // Keep the viewport stable when older pages are prepended; follow new messages when pinned to bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prevFirstId.current && firstId !== prevFirstId.current && last?.id === prevLastId.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (last && last.id !== prevLastId.current) {
      if (atBottom.current || last.sender_id === meId || !prevLastId.current) {
        el.scrollTop = el.scrollHeight;
      } else {
        setShowNewChip(true);
      }
    }
    prevHeight.current = el.scrollHeight;
    prevFirstId.current = firstId;
    prevLastId.current = last?.id;
  }, [firstId, last, meId]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    if (atBottom.current) setShowNewChip(false);
    if (el.scrollTop < 80 && thread?.hasMore && !thread.loadingOlder) {
      prevHeight.current = el.scrollHeight;
      void store.fetchOlder(conversation.id).catch(() => undefined);
    }
  };

  const scrollToBottom = () => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    setShowNewChip(false);
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setIsDeleting(true);
    try {
      await store.deleteMessage(conversation.id, deleting.id);
      setDeleting(null);
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("labi_messages.error_title"), message: apiErrorMessage(error) });
    } finally {
      setIsDeleting(false);
    }
  };

  // "Visto há 2 h" (direct) / "Visto por N" (group) under my latest message when it's the last one in the thread.
  useMinuteTick();
  let seenLabel: string | null = null;
  if (last && last.sender_id === meId && !last.client_status && !last.is_removed) {
    const others = otherMembers(conversation, meId);
    const seenBy = others.filter((m) => m.last_read_at && new Date(m.last_read_at) >= new Date(last.created_at));
    if (conversation.kind === "direct" && others.length > 0 && seenBy.length === others.length) {
      const latestRead = seenBy.map((m) => m.last_read_at as string).reduce((a, b) => (a > b ? a : b));
      seenLabel = t("labi_messages.seen_ago", { time: relativeTime(latestRead, currentLocale) });
    } else if (conversation.kind === "group" && seenBy.length > 0)
      seenLabel = t("labi_messages.seen_by", { count: seenBy.length });
  }

  const memberById = (id: string | null) => conversation.members.find((m) => m.id === id);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        // Late-loading images grow the content: stay pinned if we were at the bottom.
        onLoadCapture={() => {
          const el = scrollRef.current;
          if (el && atBottom.current) el.scrollTop = el.scrollHeight;
        }}
        role="log"
        aria-relevant="additions"
        aria-busy={!thread?.loaded || !!thread?.loadingOlder}
        aria-label={t("labi_messages.conversation_log", { name: conversationTitle(conversation, meId) })}
        className="vertical-scrollbar flex scrollbar-sm h-full flex-col gap-0.5 overflow-y-auto px-3 py-3"
      >
        {thread?.loadingOlder && <p className="py-2 text-center text-11 text-tertiary">{t("labi_messages.loading")}</p>}
        {!thread?.loaded && <p className="m-auto text-13 text-tertiary">{t("labi_messages.loading")}</p>}
        {messages.map((message, index) => {
          const prev = messages[index - 1];
          const next = messages[index + 1];
          const separator = needsSeparator(prev, message);
          const startsRun = separator || prev?.sender_id !== message.sender_id;
          const endsRun = !next || next.sender_id !== message.sender_id || needsSeparator(message, next);
          const mine = message.sender_id === meId;
          return (
            <Fragment key={message.client_id ?? message.id}>
              {separator && (
                <div className="py-3 text-center text-11 text-tertiary" role="separator">
                  {separatorLabel(message.created_at, currentLocale, t)}
                </div>
              )}
              <div className={startsRun && !separator ? "mt-2" : undefined}>
                <MessageBubble
                  message={message}
                  mine={mine}
                  sender={memberById(message.sender_id)}
                  replySender={message.reply_to ? memberById(message.reply_to.sender_id) : undefined}
                  showAvatar={endsRun}
                  showName={!mine && startsRun && conversation.kind === "group"}
                  onReply={() => onReply(message)}
                  onDelete={() => setDeleting(message)}
                  onRetry={() => void store.retryMessage(conversation.id, message.id).catch(() => undefined)}
                  onDiscard={() => store.discardMessage(conversation.id, message.id)}
                />
              </div>
            </Fragment>
          );
        })}
        {seenLabel && (
          <p className="mt-1 text-right text-11 text-tertiary" aria-hidden>
            {seenLabel}
          </p>
        )}
      </div>
      {showNewChip && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-accent-primary px-3 py-1 text-12 font-medium text-on-color shadow-raised-200"
        >
          <ArrowDown className="size-3.5" />
          {t("labi_messages.new_messages")}
        </button>
      )}
      <AlertModalCore
        isOpen={!!deleting}
        handleClose={() => setDeleting(null)}
        handleSubmit={() => void confirmDelete()}
        isSubmitting={isDeleting}
        title={t("labi_messages.delete_confirm_title")}
        content={t("labi_messages.delete_confirm_body")}
        primaryButtonText={{ loading: t("labi_messages.delete"), default: t("labi_messages.delete") }}
        secondaryButtonText={t("labi_messages.cancel")}
      />
    </div>
  );
});
