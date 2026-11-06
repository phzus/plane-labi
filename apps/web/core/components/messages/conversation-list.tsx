/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import { observer } from "mobx-react";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";
import { useMessages } from "@/hooks/store/use-messages";
import { ConversationAvatar } from "./conversation-avatar";
import { conversationPreview, conversationTitle, relativeTime, useMinuteTick } from "./helpers";

type Props = { selectedId?: string | null; onSelect: (id: string) => void };

export const ConversationList = observer(function ConversationList({ selectedId, onSelect }: Props) {
  const { t, currentLocale } = useTranslation();
  const { sortedConversations, conversationsLoaded, currentUserId } = useMessages();
  useMinuteTick();

  if (!conversationsLoaded) return <p className="p-4 text-13 text-tertiary">{t("labi_messages.loading")}</p>;
  if (sortedConversations.length === 0)
    return <p className="p-4 text-13 text-tertiary">{t("labi_messages.empty_list")}</p>;

  return (
    <ul className="flex flex-col py-1">
      {sortedConversations.map((c) => {
        const unread = c.unread_count > 0;
        const preview = conversationPreview(c, currentUserId, t);
        return (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onSelect(c.id)}
              aria-current={selectedId === c.id ? "true" : undefined}
              className={cn(
                "flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-layer-transparent-hover focus-visible:bg-layer-transparent-hover focus-visible:outline-none",
                { "bg-layer-transparent-selected": selectedId === c.id }
              )}
            >
              <ConversationAvatar conversation={c} meId={currentUserId} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={cn("truncate text-13", unread ? "font-semibold text-primary" : "text-primary")}>
                  {conversationTitle(c, currentUserId)}
                </span>
                <span
                  className={cn("flex min-w-0 gap-1 text-12", unread ? "font-semibold text-primary" : "text-tertiary")}
                >
                  <span className="truncate">{preview}</span>
                  {c.last_message_at && (
                    <span className="flex-shrink-0">· {relativeTime(c.last_message_at, currentLocale)}</span>
                  )}
                </span>
              </span>
              {unread && (
                <span className="size-2 flex-shrink-0 rounded-full bg-accent-primary">
                  <span className="sr-only">{t("labi_messages.unread_messages", { count: c.unread_count })}</span>
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
});
