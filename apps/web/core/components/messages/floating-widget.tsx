/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEvent } from "react";
import { observer } from "mobx-react";
import { usePathname } from "next/navigation";
import { Maximize2, MessageCircle, SquarePen, X } from "lucide-react";
import { EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { EUserWorkspaceRoles } from "@plane/types";
import { getNumberCount } from "@plane/utils";
import { useMessages } from "@/hooks/store/use-messages";
import { useUserPermissions } from "@/hooks/store/user";
import { useAppRouter } from "@/hooks/use-app-router";
import { MemberAvatar } from "./conversation-avatar";
import { ConversationList } from "./conversation-list";
import { ConversationView, headerIconButton } from "./conversation-view";
import { otherMembers } from "./helpers";
import { NewConversationModal } from "./new-conversation-modal";
import { useMessagesRealtime } from "./use-messages-realtime";

const MOBILE_QUERY = "(max-width: 767px)";
// Stacking: pill z-24 (under the work-item peek overview, z-25, so it never hides its comment box);
// open panel z-26 (above peek); Plane modals are z-30 and toasts ~z-1000, both stay on top.
// Portaled to <body> so no transformed/stacking ancestor can break `position: fixed`.
const FOCUSABLE = 'a[href],button:not([disabled]),textarea,input:not([type="hidden"]),[tabindex]:not([tabindex="-1"])';

/** Mounted once per workspace (layout). Owns the data bootstrap + realtime socket, and renders the pill/panel. */
export const MessagesFloatingWidget = observer(function MessagesFloatingWidget({
  workspaceSlug,
}: {
  workspaceSlug: string;
}) {
  const { t } = useTranslation();
  const store = useMessages();
  const router = useAppRouter();
  const pathname = usePathname();
  const { allowPermissions } = useUserPermissions();
  const [creating, setCreating] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);

  const canChat = allowPermissions(
    [EUserWorkspaceRoles.ADMIN, EUserWorkspaceRoles.MEMBER],
    EUserPermissionsLevel.WORKSPACE,
    workspaceSlug
  );

  useEffect(() => {
    if (!canChat) return;
    store.setWorkspace(workspaceSlug);
    void store.fetchConversations().catch(() => undefined);
  }, [canChat, store, workspaceSlug]);

  useMessagesRealtime(store, canChat);

  const { panelOpen, panelConversationId } = store;

  // Below md the open panel is full-screen, so it behaves as a modal (aria-modal + focus trap).
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // Move focus into the panel when it opens (unless a child, e.g. the composer, already took it).
  useEffect(() => {
    const panel = panelRef.current;
    if (panelOpen && panel && !panel.contains(document.activeElement))
      panel.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [panelOpen]);

  // After switching list <-> conversation the clicked element unmounts; keep focus inside the panel
  // (touch devices skip the composer autofocus), so Esc and screen readers stay in context.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panelOpen || !panel) return;
    const id = window.setTimeout(() => {
      if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(id);
  }, [panelOpen, panelConversationId]);

  const close = useCallback(() => {
    store.setPanel(false);
    // Return focus to the pill once it re-renders.
    window.setTimeout(() => pillRef.current?.focus(), 0);
  }, [store]);
  const backToList = useCallback(() => store.setPanel(true, null), [store]);

  if (!canChat || pathname.startsWith(`/${workspaceSlug}/messages`)) return null;

  const expand = () => {
    store.setPanel(false);
    router.push(`/${workspaceSlug}/messages/${panelConversationId ?? ""}`);
  };

  // Esc closes and returns focus to the pill; Tab is trapped only while full-screen (mobile).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Modals opened from the panel are portaled; React still bubbles their keys here.
    if (!panelRef.current?.contains(e.target as Node)) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab" || !isMobile || !panelRef.current) return;
    const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const unread = store.unreadConversationsCount;
  const badge = unread > 0 && (
    <span className="grid h-5 min-w-5 place-items-center rounded-full bg-danger-primary px-1.5 text-11 font-semibold text-on-color">
      {getNumberCount(unread)}
    </span>
  );
  const expandButton = (
    <button
      type="button"
      className={headerIconButton}
      onClick={expand}
      aria-label={t("labi_messages.expand")}
      title={t("labi_messages.expand")}
    >
      <Maximize2 className="size-4" />
    </button>
  );
  const closeButton = (
    <button
      type="button"
      className={headerIconButton}
      onClick={close}
      aria-label={t("labi_messages.close")}
      title={t("labi_messages.close")}
    >
      <X className="size-4" />
    </button>
  );

  if (!panelOpen) {
    const recent = store.sortedConversations.slice(0, 3);
    return createPortal(
      <button
        ref={pillRef}
        type="button"
        onClick={() => store.setPanel(true)}
        aria-label={`${t("labi_messages.open_panel")}${unread ? ` (${t("labi_messages.unread_badge", { count: unread })})` : ""}`}
        className="fixed right-4 bottom-4 z-[24] flex items-center gap-2 rounded-full border border-subtle bg-surface-1 py-2 pr-3 pl-4 text-13 font-semibold text-primary shadow-overlay-200 hover:bg-layer-1-hover focus-visible:ring-2 focus-visible:ring-accent-strong focus-visible:outline-none"
      >
        <MessageCircle className="size-5" />
        <span>{t("labi_messages.title")}</span>
        {badge}
        {recent.length > 0 && (
          <span className="flex -space-x-2" aria-hidden>
            {recent.map((c) => (
              <span key={c.id} className="rounded-full border-2 border-[var(--bg-surface-1)]">
                <MemberAvatar member={otherMembers(c, store.currentUserId)[0] ?? c.members[0]} size={22} />
              </span>
            ))}
          </span>
        )}
      </button>,
      document.body
    );
  }

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal={isMobile ? "true" : undefined}
      aria-label={t("labi_messages.title")}
      onKeyDown={onKeyDown}
      tabIndex={-1}
      // Mobile full-screen sits above Plane's top navigation (z-27) but below modals (z-30).
      className="fixed inset-x-0 top-0 z-[29] flex h-dvh flex-col overflow-hidden bg-surface-1 outline-none md:inset-auto md:right-4 md:bottom-4 md:z-[26] md:h-[530px] md:max-h-[calc(100dvh-2rem)] md:w-[370px] md:rounded-xl md:border md:border-subtle md:shadow-overlay-200"
    >
      {panelConversationId ? (
        <ConversationView
          conversationId={panelConversationId}
          onBack={backToList}
          onGone={backToList}
          actions={
            <>
              {expandButton}
              {closeButton}
            </>
          }
        />
      ) : (
        <>
          <div className="flex flex-shrink-0 items-center gap-2 border-b border-subtle px-4 py-2">
            <h2 className="text-14 font-semibold text-primary">{t("labi_messages.title")}</h2>
            {badge}
            <div className="ml-auto flex items-center">
              {expandButton}
              {closeButton}
            </div>
          </div>
          <div className="vertical-scrollbar relative scrollbar-sm min-h-0 flex-1 overflow-y-auto">
            <ConversationList onSelect={(id) => store.setPanel(true, id)} />
          </div>
          <button
            type="button"
            onClick={() => setCreating(true)}
            aria-label={t("labi_messages.new_conversation")}
            title={t("labi_messages.new_conversation")}
            className="absolute right-4 bottom-4 grid size-11 place-items-center rounded-full bg-accent-primary text-on-color shadow-raised-200 hover:bg-accent-primary-hover focus-visible:ring-2 focus-visible:ring-accent-strong focus-visible:outline-none"
          >
            <SquarePen className="size-5" />
          </button>
        </>
      )}
      <NewConversationModal
        isOpen={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => store.setPanel(true, id)}
      />
    </div>,
    document.body
  );
});
