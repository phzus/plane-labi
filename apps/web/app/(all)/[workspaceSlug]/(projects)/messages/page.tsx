/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import { observer } from "mobx-react";
import { useTranslation } from "@plane/i18n";
import { PageHead } from "@/components/core/page-title";
import { useWorkspace } from "@/hooks/store/use-workspace";

/** The UI lives in ../layout.tsx (shared with [conversationId]); pages only set the title. */
function MessagesPageHead() {
  const { t } = useTranslation();
  const { currentWorkspace } = useWorkspace();
  const title = currentWorkspace?.name ? `${currentWorkspace.name} - ${t("labi_messages.title")}` : undefined;
  return <PageHead title={title} />;
}

export default observer(MessagesPageHead);
