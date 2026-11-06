/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import { Outlet } from "react-router";
import { useParams } from "next/navigation";
import { MessagesPage } from "@/components/messages/messages-page";

export default function MessagesLayout() {
  const { workspaceSlug, conversationId } = useParams();

  return (
    <div className="relative h-full w-full overflow-hidden">
      <MessagesPage workspaceSlug={workspaceSlug?.toString() ?? ""} conversationId={conversationId?.toString()} />
      <Outlet />
    </div>
  );
}
