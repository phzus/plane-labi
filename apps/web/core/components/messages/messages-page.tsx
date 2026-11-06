/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import { useCallback, useState } from "react";
import { observer } from "mobx-react";
import { MessageCircle, SquarePen } from "lucide-react";
import { EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { EUserWorkspaceRoles } from "@plane/types";
import { cn } from "@plane/utils";
import { useMessages } from "@/hooks/store/use-messages";
import { useUserPermissions } from "@/hooks/store/user";
import { useAppRouter } from "@/hooks/use-app-router";
import { ConversationList } from "./conversation-list";
import { ConversationView, headerIconButton } from "./conversation-view";
import { NewConversationModal } from "./new-conversation-modal";

type Props = { workspaceSlug: string; conversationId?: string };

/** Full-screen Mensagens: list on the left, conversation on the right (one or the other on mobile). */
export const MessagesPage = observer(function MessagesPage({ workspaceSlug, conversationId }: Props) {
  const { t } = useTranslation();
  const router = useAppRouter();
  const { unreadConversationsCount } = useMessages();
  const [creating, setCreating] = useState(false);
  const { allowPermissions } = useUserPermissions();

  const open = useCallback((id: string) => router.push(`/${workspaceSlug}/messages/${id}`), [router, workspaceSlug]);
  const backToList = useCallback(() => router.push(`/${workspaceSlug}/messages`), [router, workspaceSlug]);

  // Guests (and anyone without ADMIN/MEMBER) reaching the URL directly: the API would answer 403.
  const canChat = allowPermissions(
    [EUserWorkspaceRoles.ADMIN, EUserWorkspaceRoles.MEMBER],
    EUserPermissionsLevel.WORKSPACE,
    workspaceSlug
  );
  if (!canChat)
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center">
        <MessageCircle className="size-12 text-tertiary" />
        <h1 className="text-16 font-semibold text-primary">{t("labi_messages.no_access_title")}</h1>
        <p className="text-13 text-tertiary">{t("labi_messages.no_access_body")}</p>
      </div>
    );

  return (
    <div className="flex h-full w-full overflow-hidden rounded-lg border border-subtle bg-surface-1">
      <aside
        className={cn("flex w-full flex-shrink-0 flex-col border-subtle md:w-[340px] md:border-r", {
          "max-md:hidden": !!conversationId,
        })}
      >
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-subtle px-4 py-3">
          <h1 className="text-16 font-semibold text-primary">{t("labi_messages.title")}</h1>
          {unreadConversationsCount > 0 && (
            <span className="grid h-5 min-w-5 place-items-center rounded-full bg-danger-primary px-1.5 text-11 font-semibold text-on-color">
              {unreadConversationsCount}
            </span>
          )}
          <button
            type="button"
            className={cn(headerIconButton, "ml-auto")}
            onClick={() => setCreating(true)}
            aria-label={t("labi_messages.new_conversation")}
            title={t("labi_messages.new_conversation")}
          >
            <SquarePen className="size-4" />
          </button>
        </div>
        <div className="vertical-scrollbar scrollbar-sm min-h-0 flex-1 overflow-y-auto">
          <ConversationList selectedId={conversationId} onSelect={open} />
        </div>
      </aside>
      <section className={cn("flex min-w-0 flex-1 flex-col", { "max-md:hidden": !conversationId })}>
        {conversationId ? (
          <ConversationView
            conversationId={conversationId}
            onBack={backToList}
            backClassName="md:hidden"
            onGone={backToList}
          />
        ) : (
          <div className="m-auto flex flex-col items-center gap-2 p-6 text-center">
            <MessageCircle className="size-12 text-tertiary" />
            <h2 className="text-16 font-semibold text-primary">{t("labi_messages.empty_select_title")}</h2>
            <p className="text-13 text-tertiary">{t("labi_messages.empty_select_body")}</p>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="mt-2 rounded-md bg-accent-primary px-3 py-1.5 text-13 font-medium text-on-color hover:bg-accent-primary-hover"
            >
              {t("labi_messages.new_conversation")}
            </button>
          </div>
        )}
      </section>
      <NewConversationModal isOpen={creating} onClose={() => setCreating(false)} onCreated={open} />
    </div>
  );
});
