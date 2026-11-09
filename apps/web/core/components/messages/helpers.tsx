/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import { Fragment, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { TChatMember, TChatMessage, TConversation, TPresenceMember } from "@/services/messages.service";

export const MAX_BODY = 4000;
export const MAX_FILES = 10;

type TFn = (key: string, params?: Record<string, unknown>) => string;

export const memberName = (m?: Pick<TChatMember, "display_name" | "first_name" | "last_name">) =>
  m ? [m.first_name, m.last_name].filter(Boolean).join(" ") || m.display_name : "";

export const otherMembers = (c: TConversation, meId?: string) => c.members.filter((m) => m.id !== meId);

export const conversationTitle = (c: TConversation, meId?: string) => {
  const others = otherMembers(c, meId);
  if (c.kind === "direct") return memberName(others[0]) || memberName(c.members[0]);
  return c.name || others.map((m) => m.first_name || m.display_name).join(", ");
};

export const conversationPreview = (c: TConversation, meId: string | undefined, t: TFn) => {
  const m = c.last_message;
  if (!m) return "";
  const mine = m.sender_id === meId;
  if (m.is_removed) return t("labi_messages.removed");
  if (!m.body && m.attachments.length) {
    if (mine) return t("labi_messages.you_sent_attachment");
    const sender = c.members.find((x) => x.id === m.sender_id);
    return t("labi_messages.sent_attachment", {
      name: sender?.first_name || memberName(sender) || t("labi_messages.someone"),
    });
  }
  return mine ? t("labi_messages.you_prefix", { text: m.body }) : m.body;
};

// One shared 60s timer for every relative timestamp on screen.
let minuteNow = Date.now();
let minuteTimer: number | undefined;
const minuteListeners = new Set<() => void>();
const subscribeMinute = (listener: () => void) => {
  minuteListeners.add(listener);
  minuteTimer ??= window.setInterval(() => {
    minuteNow = Date.now();
    minuteListeners.forEach((l) => l());
  }, 60_000);
  return () => {
    minuteListeners.delete(listener);
    if (minuteListeners.size === 0) {
      window.clearInterval(minuteTimer);
      minuteTimer = undefined;
    }
  };
};
/** Re-renders the caller once a minute so relative times stay fresh. */
export const useMinuteTick = () => useSyncExternalStore(subscribeMinute, () => minuteNow);

/** Compact relative time for the conversation list ("5 min", "2 h"). */
export const relativeTime = (iso: string | null, locale: string) => {
  if (!iso) return "";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  const rtf = new Intl.RelativeTimeFormat(locale, { style: "narrow", numeric: "auto" });
  if (minutes < 60) return rtf.format(-Math.max(minutes, 0), "minute");
  if (minutes < 60 * 24) return rtf.format(-Math.round(minutes / 60), "hour");
  if (minutes < 60 * 24 * 7) return rtf.format(-Math.round(minutes / 1440), "day");
  return rtf.format(-Math.round(minutes / 10080), "week");
};

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** Instagram-style status: "Online agora", "Online há 2 min", "Online há 1 h". */
export const presenceLabel = (presence: TPresenceMember | undefined, t: TFn) => {
  if (presence?.is_online) return t("labi_messages.online_now");
  if (!presence?.last_seen_at) return t("labi_messages.offline");
  const minutes = Math.max(1, Math.round((Date.now() - new Date(presence.last_seen_at).getTime()) / 60000));
  if (minutes < 60) return t("labi_messages.online_ago_minutes", { count: minutes });
  if (minutes < 1440) return t("labi_messages.online_ago_hours", { count: Math.round(minutes / 60) });
  if (minutes < 10080) return t("labi_messages.online_ago_days", { count: Math.round(minutes / 1440) });
  return t("labi_messages.online_ago_weeks", { count: Math.round(minutes / 10080) });
};

export const onlineOthers = (c: TConversation, meId: string | undefined, presence: Map<string, TPresenceMember>) =>
  otherMembers(c, meId).filter((m) => presence.get(m.id)?.is_online).length;

/** Separator label: "Hoje, 14:32", "Qui, 22:49", "12 de out., 14:32". */
export const separatorLabel = (iso: string, locale: string, t: TFn) => {
  const date = new Date(iso);
  const now = new Date();
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (sameDay(date, now)) return `${t("labi_messages.today")}, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `${t("labi_messages.yesterday")}, ${time}`;
  const diffDays = (now.getTime() - date.getTime()) / 86400000;
  const day =
    diffDays < 7
      ? date.toLocaleDateString(locale, { weekday: "short" }).replace(".", "")
      : date.toLocaleDateString(locale, { day: "numeric", month: "short" });
  return `${day.charAt(0).toUpperCase()}${day.slice(1)}, ${time}`;
};

/** A separator goes before a message when the day changes or after a 30-minute gap. */
export const needsSeparator = (prev: TChatMessage | undefined, cur: TChatMessage) => {
  if (!prev) return true;
  const a = new Date(prev.created_at);
  const b = new Date(cur.created_at);
  return !sameDay(a, b) || b.getTime() - a.getTime() > 30 * 60000;
};

export const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;

/** Plain text with clickable http(s) links; newlines kept via whitespace-pre-wrap on the container. */
export const linkify = (text: string): ReactNode =>
  text.split(URL_RE).map((part, i) =>
    i % 2 === 1 ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all underline underline-offset-2"
      >
        {part}
      </a>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    )
  );

const firstString = (v: unknown): string | undefined => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return firstString(v[0]);
  if (v && typeof v === "object") return firstString(Object.values(v)[0]);
  return undefined;
};

/** Extract a human message from DRF error payloads ({field: ["msg"]}, {error}, {detail}, ["msg"]). */
export const apiErrorMessage = (error: unknown): string | undefined =>
  firstString((error as { response?: { data?: unknown } })?.response?.data);

export const httpStatus = (error: unknown): number | undefined =>
  (error as { response?: { status?: number } })?.response?.status;
