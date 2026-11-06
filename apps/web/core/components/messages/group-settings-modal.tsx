/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { UserMinus, UserPlus, X } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { AlertModalCore, EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { useMessages } from "@/hooks/store/use-messages";
import type { TConversation } from "@/services/messages.service";
import { MemberAvatar } from "./conversation-avatar";
import { apiErrorMessage, memberName } from "./helpers";
import { NewConversationModal } from "./new-conversation-modal";

type Props = { conversation: TConversation; isOpen: boolean; onClose: () => void; onLeft: () => void };

export const GroupSettingsModal = observer(function GroupSettingsModal(props: Props) {
  const { conversation, isOpen, onClose, onLeft } = props;
  const { t } = useTranslation();
  const store = useMessages();
  const meId = store.currentUserId;
  const isAdmin = !!conversation.members.find((m) => m.id === meId)?.is_admin;
  const [name, setName] = useState(conversation.name);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (isOpen) setName(conversation.name);
  }, [isOpen, conversation.name]);

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("labi_messages.error_title"), message: apiErrorMessage(error) });
    }
  };

  const rename = () =>
    run(async () => {
      setSaving(true);
      try {
        await store.renameConversation(conversation.id, name.trim());
      } finally {
        setSaving(false);
      }
    });

  const leave = () =>
    run(async () => {
      setLeaving(true);
      try {
        await store.removeMember(conversation.id, meId ?? "");
        setConfirmLeave(false);
        onClose();
        onLeft();
      } finally {
        setLeaving(false);
      }
    });

  return (
    <>
      <ModalCore
        isOpen={isOpen && !adding && !confirmLeave}
        handleClose={onClose}
        position={EModalPosition.TOP}
        width={EModalWidth.MD}
      >
        <div className="flex max-h-[70vh] flex-col">
          <div className="flex items-center justify-between border-b border-subtle px-4 py-3">
            <h2 className="text-14 font-semibold text-primary">{t("labi_messages.group_options")}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("labi_messages.close")}
              className="grid size-7 place-items-center rounded-full text-secondary hover:bg-layer-transparent-hover pointer-coarse:size-10"
            >
              <X className="size-4" />
            </button>
          </div>
          {isAdmin && (
            <form
              className="flex items-center gap-2 border-b border-subtle px-4 py-3"
              onSubmit={(e) => {
                e.preventDefault();
                void rename();
              }}
            >
              <input
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("labi_messages.rename")}
                aria-label={t("labi_messages.rename")}
                className="flex-1 rounded-md border border-subtle bg-transparent px-2 py-1.5 text-13 text-primary outline-none placeholder:text-placeholder focus:border-strong"
              />
              <Button variant="secondary" type="submit" loading={saving} disabled={name.trim() === conversation.name}>
                {t("labi_messages.save")}
              </Button>
            </form>
          )}
          <div className="flex items-center justify-between px-4 pt-3 pb-1">
            <h3 className="text-12 font-medium text-tertiary">{t("labi_messages.members")}</h3>
            {isAdmin && (
              <Button
                variant="ghost"
                size="sm"
                prependIcon={<UserPlus className="size-3.5" />}
                onClick={() => setAdding(true)}
              >
                {t("labi_messages.add_people")}
              </Button>
            )}
          </div>
          <ul className="vertical-scrollbar scrollbar-sm min-h-0 flex-1 overflow-y-auto pb-2">
            {conversation.members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-4 py-2">
                <MemberAvatar member={m} size={32} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-13 text-primary">{memberName(m)}</span>
                  {m.is_admin && <span className="text-11 text-tertiary">{t("labi_messages.admin")}</span>}
                </span>
                {isAdmin && m.id !== meId && (
                  <button
                    type="button"
                    onClick={() => void run(() => store.removeMember(conversation.id, m.id))}
                    aria-label={t("labi_messages.remove_person", { name: memberName(m) })}
                    title={t("labi_messages.remove_person", { name: memberName(m) })}
                    className="grid size-7 place-items-center rounded-full text-tertiary hover:bg-layer-transparent-hover hover:text-danger-primary pointer-coarse:size-10"
                  >
                    <UserMinus className="size-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="border-t border-subtle px-4 py-3">
            <Button
              variant="error-outline"
              size="lg"
              className="w-full justify-center"
              onClick={() => setConfirmLeave(true)}
            >
              {t("labi_messages.leave")}
            </Button>
          </div>
        </div>
      </ModalCore>
      <NewConversationModal
        isOpen={isOpen && adding}
        mode="add"
        excludeIds={conversation.members.map((m) => m.id)}
        onClose={() => setAdding(false)}
        onAdd={(ids) => store.addMembers(conversation.id, ids)}
      />
      <AlertModalCore
        isOpen={isOpen && confirmLeave}
        handleClose={() => setConfirmLeave(false)}
        handleSubmit={() => void leave()}
        isSubmitting={leaving}
        title={t("labi_messages.leave")}
        content={t("labi_messages.leave_confirm_body")}
        primaryButtonText={{ loading: t("labi_messages.leave"), default: t("labi_messages.leave") }}
        secondaryButtonText={t("labi_messages.cancel")}
      />
    </>
  );
});
