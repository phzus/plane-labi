/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import { useMemo, useState } from "react";
import { observer } from "mobx-react";
import { Check, X } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { EUserWorkspaceRoles } from "@plane/types";
import { Avatar, EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { cn, getFileURL } from "@plane/utils";
import { useMember } from "@/hooks/store/use-member";
import { useMessages } from "@/hooks/store/use-messages";
import { apiErrorMessage, memberName } from "./helpers";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  /** "add" picks people for an existing group (excludeIds = current members). */
  mode?: "create" | "add";
  excludeIds?: string[];
  onCreated?: (conversationId: string) => void;
  onAdd?: (memberIds: string[]) => Promise<void>;
};

export const NewConversationModal = observer(function NewConversationModal(props: Props) {
  const { isOpen, onClose, mode = "create", excludeIds = [], onCreated, onAdd } = props;
  const { t } = useTranslation();
  const store = useMessages();
  const {
    workspace: { getWorkspaceMemberIds, getWorkspaceMemberDetails },
  } = useMember();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [groupName, setGroupName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const slug = store.workspaceSlug ?? "";
  const meId = store.currentUserId;
  const memberIds = getWorkspaceMemberIds(slug);
  const people = useMemo(
    () =>
      memberIds
        .map((id) => getWorkspaceMemberDetails(id))
        .filter(
          (m): m is NonNullable<typeof m> =>
            !!m?.member &&
            m.is_active !== false &&
            m.role >= EUserWorkspaceRoles.MEMBER &&
            !m.member.is_bot &&
            m.member.id !== meId &&
            !excludeIds.includes(m.member.id)
        ),
    [memberIds, getWorkspaceMemberDetails, meId, excludeIds]
  );
  const q = query.trim().toLowerCase();
  const visible = q
    ? people.filter((m) =>
        `${m.member.first_name} ${m.member.last_name} ${m.member.display_name} ${m.member.email ?? ""}`
          .toLowerCase()
          .includes(q)
      )
    : people;

  const close = () => {
    setQuery("");
    setSelected([]);
    setGroupName("");
    onClose();
  };

  const toggle = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  const submit = async () => {
    if (!selected.length) return;
    setSubmitting(true);
    try {
      if (mode === "add") await onAdd?.(selected);
      else {
        const conversation = await store.createConversation(
          selected,
          selected.length > 1 ? groupName.trim() : undefined
        );
        onCreated?.(conversation.id);
      }
      close();
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("labi_messages.error_title"), message: apiErrorMessage(error) });
    } finally {
      setSubmitting(false);
    }
  };

  const selectedPeople = people.filter((m) => selected.includes(m.member.id));

  return (
    <ModalCore isOpen={isOpen} handleClose={close} position={EModalPosition.TOP} width={EModalWidth.MD}>
      <div className="flex max-h-[70vh] flex-col">
        <div className="flex items-center justify-between border-b border-subtle px-4 py-3">
          <h2 className="text-14 font-semibold text-primary">
            {t(mode === "add" ? "labi_messages.add_people" : "labi_messages.new_conversation")}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label={t("labi_messages.close")}
            className="grid size-7 place-items-center rounded-full text-secondary hover:bg-layer-transparent-hover pointer-coarse:size-10"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1 border-b border-subtle px-4 py-2">
          <span className="text-13 font-medium text-primary">{t("labi_messages.to")}</span>
          {selectedPeople.map((m) => (
            <button
              key={m.member.id}
              type="button"
              onClick={() => toggle(m.member.id)}
              className="flex items-center gap-1 rounded-full bg-accent-primary/10 px-2 py-0.5 text-12 text-accent-primary"
              aria-label={t("labi_messages.remove_person", { name: memberName(m.member) })}
            >
              {memberName(m.member)}
              <X className="size-3" />
            </button>
          ))}
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("labi_messages.search_people")}
            aria-label={t("labi_messages.search_people")}
            className="min-w-[120px] flex-1 bg-transparent px-1 py-1 text-13 text-primary outline-none placeholder:text-placeholder"
          />
        </div>
        <ul
          className="vertical-scrollbar scrollbar-sm min-h-0 flex-1 overflow-y-auto py-1"
          aria-label={t("labi_messages.members")}
        >
          {visible.length === 0 && <li className="px-4 py-3 text-13 text-tertiary">{t("labi_messages.no_people")}</li>}
          {visible.map((m) => {
            const isSelected = selected.includes(m.member.id);
            return (
              <li key={m.member.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isSelected}
                  onClick={() => toggle(m.member.id)}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-layer-transparent-hover focus-visible:bg-layer-transparent-hover focus-visible:outline-none"
                >
                  <Avatar
                    name={memberName(m.member)}
                    src={m.member.avatar_url ? getFileURL(m.member.avatar_url) : undefined}
                    size={32}
                    showTooltip={false}
                    className="object-cover"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-13 text-primary">{memberName(m.member)}</span>
                    <span className="truncate text-11 text-tertiary">{m.member.display_name}</span>
                  </span>
                  <span
                    className={cn(
                      "grid size-5 place-items-center rounded-full border",
                      isSelected ? "border-accent-strong bg-accent-primary text-on-color" : "border-strong"
                    )}
                  >
                    {isSelected && <Check className="size-3" />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {mode === "create" && selected.length > 1 && (
          <div className="border-t border-subtle px-4 py-2">
            <input
              value={groupName}
              maxLength={80}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder={t("labi_messages.group_name")}
              aria-label={t("labi_messages.group_name")}
              className="w-full rounded-md border border-subtle bg-transparent px-2 py-1.5 text-13 text-primary outline-none placeholder:text-placeholder focus:border-strong"
            />
          </div>
        )}
        <div className="border-t border-subtle px-4 py-3">
          <Button
            variant="primary"
            size="lg"
            className="w-full justify-center"
            disabled={!selected.length}
            loading={submitting}
            onClick={() => void submit()}
          >
            {t(mode === "add" ? "labi_messages.add" : "labi_messages.start")}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
});
