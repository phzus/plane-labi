/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import { FileText, Reply, Trash2 } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { cn, getFileURL } from "@plane/utils";
import type { TChatMember, TChatMessage } from "@/services/messages.service";
import { MemberAvatar } from "./conversation-avatar";
import { formatSize, linkify, memberName } from "./helpers";

type Props = {
  message: TChatMessage;
  mine: boolean;
  sender?: TChatMember;
  replySender?: TChatMember;
  showAvatar: boolean;
  showName: boolean;
  onReply: () => void;
  onDelete: () => void;
  onRetry: () => void;
  onDiscard: () => void;
};

const iconButton =
  "grid size-7 pointer-coarse:size-10 place-items-center rounded-full text-tertiary hover:bg-layer-transparent-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-strong";

export function MessageBubble(props: Props) {
  const { message, mine, sender, replySender, showAvatar, showName, onReply, onDelete, onRetry, onDiscard } = props;
  const { t } = useTranslation();
  const pending = !!message.client_status;
  const images = message.attachments.filter((a) => a.type.startsWith("image/"));
  const files = message.attachments.filter((a) => !a.type.startsWith("image/"));

  const actions = !message.is_removed && !pending && (
    <div
      // Hover/focus on desktop; always visible on touch screens (no hover there).
      className="flex flex-shrink-0 items-center self-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
    >
      <button
        type="button"
        className={iconButton}
        onClick={onReply}
        aria-label={t("labi_messages.reply")}
        title={t("labi_messages.reply")}
      >
        <Reply className="size-4" />
      </button>
      {mine && (
        <button
          type="button"
          className={iconButton}
          onClick={onDelete}
          aria-label={t("labi_messages.delete")}
          title={t("labi_messages.delete")}
        >
          <Trash2 className="size-4" />
        </button>
      )}
    </div>
  );

  return (
    <div className={cn("group flex flex-col", mine ? "items-end" : "items-start")}>
      {showName && sender && (
        <span className="mb-0.5 ml-10 text-11 text-tertiary">{sender.first_name || memberName(sender)}</span>
      )}
      <div className={cn("flex max-w-full items-end gap-2", mine ? "flex-row-reverse" : "flex-row")}>
        {!mine && <div className="w-7 flex-shrink-0">{showAvatar && <MemberAvatar member={sender} size={28} />}</div>}
        <div className={cn("flex max-w-[75%] min-w-0 flex-col gap-1", mine ? "items-end" : "items-start")}>
          {message.reply_to && (
            <div className="max-w-full truncate rounded-xl border border-subtle px-3 py-1 text-12 text-tertiary">
              <span className="font-medium">{memberName(replySender) || t("labi_messages.someone")}: </span>
              {message.reply_to.is_removed ? t("labi_messages.removed") : message.reply_to.body}
            </div>
          )}
          {message.is_removed ? (
            <div className="rounded-2xl border border-subtle px-3 py-2 text-13 text-tertiary italic">
              {t("labi_messages.removed")}
            </div>
          ) : (
            <>
              {images.length > 0 && (
                <div className={cn("flex flex-wrap gap-1", mine ? "justify-end" : "justify-start")}>
                  {images.map((a) => (
                    <a
                      key={a.id}
                      href={getFileURL(a.url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t("labi_messages.open_image", { name: a.name })}
                      className="block overflow-hidden rounded-xl border border-subtle"
                    >
                      <img
                        src={getFileURL(a.url)}
                        alt={a.name}
                        loading="lazy"
                        // Fixed box (cropped) so late-loading images never shift the log.
                        className={cn("bg-layer-2 object-cover", images.length > 1 ? "size-28" : "h-48 w-48")}
                      />
                    </a>
                  ))}
                </div>
              )}
              {files.map((a) => (
                <a
                  key={a.id}
                  href={`${getFileURL(a.url)}?download=1`}
                  aria-label={t("labi_messages.download", { name: a.name })}
                  className="flex max-w-[260px] items-center gap-2 rounded-xl border border-subtle bg-layer-1 px-3 py-2 hover:bg-layer-1-hover"
                >
                  <FileText className="size-5 flex-shrink-0 text-secondary" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-13 text-primary">{a.name}</span>
                    <span className="text-11 text-tertiary">{formatSize(a.size)}</span>
                  </span>
                </a>
              ))}
              {message.body && (
                <div
                  className={cn(
                    "max-w-full rounded-2xl px-3 py-2 text-13 break-words whitespace-pre-wrap",
                    mine ? "bg-accent-primary text-on-color" : "bg-layer-2 text-primary",
                    { "opacity-60": pending }
                  )}
                >
                  {linkify(message.body)}
                </div>
              )}
            </>
          )}
        </div>
        {actions}
      </div>
      {message.client_status === "pending" && (
        <span className="mt-0.5 text-11 text-tertiary" aria-hidden>
          {t("labi_messages.sending")}
        </span>
      )}
      {message.client_status === "failed" && (
        <span className="mt-0.5 flex items-center gap-2 text-11 text-danger-primary" role="alert">
          {message.client_error_status === 429 ? t("labi_messages.rate_limited") : t("labi_messages.failed")}
          <button type="button" className="font-medium underline" onClick={onRetry}>
            {t("labi_messages.retry")}
          </button>
          <button type="button" className="underline" onClick={onDiscard}>
            {t("labi_messages.discard")}
          </button>
        </span>
      )}
    </div>
  );
}
