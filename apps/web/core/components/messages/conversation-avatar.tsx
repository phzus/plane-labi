/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import { Avatar } from "@plane/ui";
import { getFileURL } from "@plane/utils";
import type { TChatMember, TConversation } from "@/services/messages.service";
import { memberName, otherMembers } from "./helpers";

export function MemberAvatar({ member, size = 28 }: { member?: TChatMember; size?: number }) {
  return (
    <Avatar
      name={memberName(member)}
      src={member?.avatar_url ? getFileURL(member.avatar_url) : undefined}
      size={size}
      showTooltip={false}
      className="object-cover"
    />
  );
}

/** Single avatar for direct chats; two overlapped avatars for groups. */
export function ConversationAvatar({
  conversation,
  meId,
  size = 44,
}: {
  conversation: TConversation;
  meId?: string;
  size?: number;
}) {
  const others = otherMembers(conversation, meId);
  if (conversation.kind === "direct" || others.length < 2)
    return <MemberAvatar member={others[0] ?? conversation.members[0]} size={size} />;
  const small = Math.round(size * 0.72);
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }} aria-hidden>
      <div className="absolute top-0 right-0">
        <MemberAvatar member={others[0]} size={small} />
      </div>
      <div className="absolute bottom-0 left-0 rounded-full border-2 border-[var(--bg-surface-1)]">
        <MemberAvatar member={others[1]} size={small} />
      </div>
    </div>
  );
}
