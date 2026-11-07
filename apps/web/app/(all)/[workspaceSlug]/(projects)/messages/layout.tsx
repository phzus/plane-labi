/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import { MessagesSquare } from "lucide-react";
import { Outlet } from "react-router";
import { useParams } from "next/navigation";
import { useTranslation } from "@plane/i18n";
import { Breadcrumbs, Header } from "@plane/ui";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { AppHeader } from "@/components/core/app-header";
import { MessagesPage } from "@/components/messages/messages-page";

export default function MessagesLayout() {
  const { workspaceSlug, conversationId } = useParams();
  const { t } = useTranslation();

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      {/* Standard Plane page header: shows the "open sidebar" button when the sidebar is collapsed. */}
      <AppHeader
        header={
          <Header>
            <Header.LeftItem>
              <Breadcrumbs>
                <Breadcrumbs.Item
                  component={
                    <BreadcrumbLink
                      label={t("labi_messages.title")}
                      icon={<MessagesSquare className="h-4 w-4 text-tertiary" aria-hidden />}
                    />
                  }
                />
              </Breadcrumbs>
            </Header.LeftItem>
          </Header>
        }
      />
      <div className="min-h-0 flex-1">
        <MessagesPage workspaceSlug={workspaceSlug?.toString() ?? ""} conversationId={conversationId?.toString()} />
      </div>
      <Outlet />
    </div>
  );
}
