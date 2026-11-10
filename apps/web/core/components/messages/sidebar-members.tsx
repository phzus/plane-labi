/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team presence in the sidebar (see LABI-CHANGES.md)
import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { Disclosure, Transition } from "@headlessui/react";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { IconButton } from "@plane/propel/icon-button";
import { ChevronRightIcon, PlusIcon } from "@plane/propel/icons";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { Tooltip } from "@plane/propel/tooltip";
import type { IWorkspaceBulkInviteFormData } from "@plane/types";
import { cn } from "@plane/utils";
import { SendWorkspaceInvitationModal } from "@/components/workspace/members";
import { useMember } from "@/hooks/store/use-member";
import { useMessages } from "@/hooks/store/use-messages";
import { useUserPermissions } from "@/hooks/store/user";
import { MemberAvatar } from "./conversation-avatar";
import { memberName } from "./helpers";

const OPEN_KEY = "labi_members_open";

const readOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) !== "false";
  } catch {
    return true;
  }
};

/** "Membros" accordion below "Projetos": photo, name and an online/offline dot with its label. */
export const SidebarMembers = observer(function SidebarMembers() {
  const { workspaceSlug } = useParams();
  const { t } = useTranslation();
  const store = useMessages();
  const [isOpen, setIsOpen] = useState(readOpen);
  const [inviteOpen, setInviteOpen] = useState(false);
  const { allowPermissions } = useUserPermissions();
  const {
    workspace: { inviteMembersToWorkspace },
  } = useMember();
  const canInvite = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);
  const slug = workspaceSlug?.toString();

  useEffect(() => {
    if (!slug) return;
    store.setWorkspace(slug);
    void store.fetchPresence();
  }, [store, slug]);

  const toggle = () => {
    const next = !isOpen;
    setIsOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, String(next));
    } catch {
      // storage unavailable: the choice just lasts until reload
    }
  };

  if (store.presence.length === 0) return null;
  const toggleLabel = t(isOpen ? "labi_messages.members_close" : "labi_messages.members_open");
  const inviteLabel = t("labi_messages.members_invite");

  // Same flow as the workspace members settings page.
  const handleInvite = async (data: IWorkspaceBulkInviteFormData) => {
    try {
      await inviteMembersToWorkspace(slug ?? "", data);
      setInviteOpen(false);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("workspace_settings.settings.members.invitations_sent_successfully"),
      });
    } catch (error: unknown) {
      const message = (error as { error?: string } | undefined)?.error;
      setToast({ type: TOAST_TYPE.ERROR, title: message ?? t("something_went_wrong_please_try_again") });
      throw error;
    }
  };

  return (
    <Disclosure as="div" className="flex flex-col" defaultOpen={isOpen}>
      {canInvite && (
        <SendWorkspaceInvitationModal
          isOpen={inviteOpen}
          onClose={() => setInviteOpen(false)}
          onSubmit={handleInvite}
        />
      )}
      <div className="group flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-placeholder hover:bg-layer-transparent-hover">
        <Disclosure.Button
          as="button"
          type="button"
          className="flex w-full items-center gap-1 text-left text-13 font-semibold whitespace-nowrap text-placeholder"
          onClick={toggle}
          aria-label={toggleLabel}
        >
          <span className="text-13 font-semibold">{t("members")}</span>
        </Disclosure.Button>
        <div className="flex items-center gap-1">
          {canInvite && (
            <Tooltip tooltipHeading={inviteLabel} tooltipContent="">
              <IconButton
                variant="ghost"
                size="sm"
                icon={PlusIcon}
                onClick={() => setInviteOpen(true)}
                className="hidden text-placeholder group-hover:inline-flex"
                aria-label={inviteLabel}
              />
            </Tooltip>
          )}
          <IconButton
            variant="ghost"
            size="sm"
            icon={ChevronRightIcon}
            onClick={toggle}
            className="text-placeholder"
            iconClassName={cn("transition-transform", { "rotate-90": isOpen })}
            aria-label={toggleLabel}
          />
        </div>
      </div>
      <Transition
        show={isOpen}
        enter="transition duration-100 ease-out"
        enterFrom="transform scale-95 opacity-0"
        enterTo="transform scale-100 opacity-100"
        leave="transition duration-75 ease-out"
        leaveFrom="transform scale-100 opacity-100"
        leaveTo="transform scale-95 opacity-0"
      >
        <Disclosure.Panel as="ul" className="flex flex-col gap-0.5" static>
          {store.presence.map((member) => (
            <li key={member.id} className="flex items-center gap-2 rounded-sm px-2 py-1 text-13 text-secondary">
              <MemberAvatar member={{ ...member, is_admin: false, last_read_at: null }} size={20} />
              <span className="min-w-0 flex-1 truncate">{memberName(member)}</span>
              <span className="flex flex-shrink-0 items-center gap-1.5 text-11 text-tertiary">
                <span
                  aria-hidden
                  className={cn("size-2 rounded-full", member.is_online ? "bg-[#22c55e]" : "bg-[#9ca3af]")}
                />
                {t(member.is_online ? "labi_messages.online" : "labi_messages.offline")}
              </span>
            </li>
          ))}
        </Disclosure.Panel>
      </Transition>
    </Disclosure>
  );
});
