/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import { observer } from "mobx-react";
import { getNumberCount } from "@plane/utils";
import { CountChip } from "@/components/common/count-chip";
import { useMessages } from "@/hooks/store/use-messages";

/** Unread conversations count next to "Mensagens" in the sidebar (data is loaded by the floating widget). */
export const MessagesSidebarBadge = observer(function MessagesSidebarBadge() {
  const { unreadConversationsCount } = useMessages();
  if (unreadConversationsCount <= 0) return null;
  return (
    <div className="ml-auto">
      <CountChip count={getNumberCount(unreadConversationsCount)} />
    </div>
  );
});
