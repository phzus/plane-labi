/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { FileText, Paperclip, SendHorizontal, X } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { cn } from "@plane/utils";
import { useMessages } from "@/hooks/store/use-messages";
import type { TChatAttachment, TChatMessage, TConversation } from "@/services/messages.service";
import { apiErrorMessage, httpStatus, MAX_BODY, MAX_FILES, memberName } from "./helpers";

type TDraftFile = { key: string; file: File; preview?: string; progress: number; attachment?: TChatAttachment };

type Props = { conversation: TConversation; replyTo: TChatMessage | null; onCancelReply: () => void };

const iconButton =
  "grid size-8 pointer-coarse:size-10 flex-shrink-0 place-items-center rounded-full text-secondary hover:bg-layer-transparent-hover hover:text-primary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-strong";

export const Composer = observer(function Composer({ conversation, replyTo, onCancelReply }: Props) {
  const { t } = useTranslation();
  const store = useMessages();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<TDraftFile[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  // Free preview URLs on unmount.
  useEffect(() => () => filesRef.current.forEach((f) => f.preview && URL.revokeObjectURL(f.preview)), []);

  // Focus on open (skipped on touch screens so the keyboard doesn't pop up) and when replying.
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) textareaRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  // Autosize the textarea up to ~6 lines.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const updateFile = (key: string, patch: Partial<TDraftFile>) =>
    setFiles((current) => current.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const removeFile = (key: string) =>
    setFiles((current) => {
      const target = current.find((f) => f.key === key);
      if (target?.preview) URL.revokeObjectURL(target.preview);
      return current.filter((f) => f.key !== key);
    });

  const addFiles = (incoming: File[]) => {
    const slug = store.workspaceSlug;
    if (!incoming.length || !slug) return;
    const room = MAX_FILES - filesRef.current.length;
    if (incoming.length > room)
      setToast({ type: TOAST_TYPE.WARNING, title: t("labi_messages.too_many_files", { max: MAX_FILES }) });
    const drafts: TDraftFile[] = incoming.slice(0, Math.max(room, 0)).map((file) => ({
      key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
      file,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      progress: 0,
    }));
    setFiles((current) => [...current, ...drafts]);
    drafts.forEach((draft) => {
      store.service
        .uploadAttachment(slug, conversation.id, draft.file, (e) =>
          updateFile(draft.key, { progress: e.total ? e.loaded / e.total : 0 })
        )
        .then((attachment) => updateFile(draft.key, { attachment, progress: 1 }))
        .catch((error) => {
          removeFile(draft.key);
          const notAllowed = httpStatus(error) === 400;
          setToast({
            type: TOAST_TYPE.ERROR,
            title: t(notAllowed ? "labi_messages.file_not_allowed" : "labi_messages.upload_failed", {
              name: draft.file.name,
            }),
            message: apiErrorMessage(error),
          });
        });
    });
  };

  const uploading = files.some((f) => !f.attachment);
  const tooLong = text.length > MAX_BODY;
  const canSend = (text.trim().length > 0 || files.length > 0) && !uploading && !tooLong;

  const send = () => {
    if (!canSend) return;
    const attachments = files.map((f) => f.attachment as TChatAttachment);
    const body = text.trim();
    const reply = replyTo
      ? { id: replyTo.id, sender_id: replyTo.sender_id, body: replyTo.body, is_removed: replyTo.is_removed }
      : null;
    files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
    setText("");
    setFiles([]);
    onCancelReply();
    // Failures are shown inline under the bubble with "Tentar de novo".
    void store.sendMessage(
      conversation.id,
      { body, reply_to_id: reply?.id ?? null, attachment_ids: attachments.map((a) => a.id) },
      { body, attachments, reply_to: reply }
    );
  };

  const replyName = replyTo
    ? memberName(conversation.members.find((m) => m.id === replyTo.sender_id)) || t("labi_messages.someone")
    : "";

  return (
    <div className="flex-shrink-0 border-t border-subtle p-2">
      {replyTo && (
        <div className="mb-2 flex items-start gap-2 rounded-lg bg-layer-1 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-11 font-medium text-secondary">{t("labi_messages.replying_to", { name: replyName })}</p>
            <p className="truncate text-12 text-tertiary">
              {replyTo.is_removed ? t("labi_messages.removed") : replyTo.body || t("labi_messages.attachment")}
            </p>
          </div>
          <button
            type="button"
            className={iconButton}
            onClick={onCancelReply}
            aria-label={t("labi_messages.cancel_reply")}
          >
            <X className="size-4" />
          </button>
        </div>
      )}
      {files.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2">
          {files.map((f) => (
            <li
              key={f.key}
              className="relative flex h-14 max-w-[180px] items-center gap-2 overflow-hidden rounded-lg border border-subtle bg-layer-1 pr-8"
            >
              {f.preview ? (
                <img src={f.preview} alt="" className="h-full w-14 object-cover" />
              ) : (
                <FileText className="ml-2 size-5 flex-shrink-0 text-secondary" />
              )}
              <span className="truncate text-12 text-primary">{f.file.name}</span>
              <button
                type="button"
                className="absolute top-0 right-0 grid size-7 place-items-center rounded-full text-secondary hover:text-primary pointer-coarse:size-10"
                onClick={() => removeFile(f.key)}
                aria-label={t("labi_messages.remove_file", { name: f.file.name })}
              >
                <X className="size-4 rounded-full bg-layer-3 p-0.5" />
              </button>
              {!f.attachment && (
                <span
                  className="absolute bottom-0 left-0 h-0.5 bg-accent-primary transition-all"
                  style={{ width: `${Math.round(f.progress * 100)}%` }}
                  role="progressbar"
                  aria-valuenow={Math.round(f.progress * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={f.file.name}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-1 rounded-2xl border border-subtle px-1 py-1 focus-within:border-strong">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className={iconButton}
          onClick={() => fileInputRef.current?.click()}
          disabled={files.length >= MAX_FILES}
          aria-label={t("labi_messages.attach")}
          title={t("labi_messages.attach")}
        >
          <Paperclip className="size-4" />
        </button>
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
            if (pasted.length) {
              e.preventDefault();
              addFiles(pasted);
            }
          }}
          placeholder={t("labi_messages.placeholder")}
          aria-label={t("labi_messages.placeholder")}
          className="max-h-[140px] min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-13 text-primary outline-none placeholder:text-placeholder"
        />
        {text.length > MAX_BODY - 200 && (
          <span className={cn("self-center text-11", tooLong ? "text-danger-primary" : "text-tertiary")} aria-hidden>
            {text.length}/{MAX_BODY}
          </span>
        )}
        {/* Announced once when crossing the limit, not on every keystroke. */}
        <span className="sr-only" aria-live="polite">
          {tooLong ? t("labi_messages.too_long", { max: MAX_BODY }) : ""}
        </span>
        <button
          type="button"
          className={cn(iconButton, "text-accent-primary hover:text-accent-primary")}
          onClick={send}
          disabled={!canSend}
          aria-label={t("labi_messages.send")}
          title={t("labi_messages.send")}
        >
          <SendHorizontal className="size-4" />
        </button>
      </div>
    </div>
  );
});
