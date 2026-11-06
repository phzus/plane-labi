/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import { useContext } from "react";
// mobx store
import { StoreContext } from "@/lib/store-context";
// types
import type { IMessagesStore } from "@/store/messages.store";

export const useMessages = (): IMessagesStore => {
  const context = useContext(StoreContext);
  if (context === undefined) throw new Error("useMessages must be used within StoreProvider");
  return context.messages;
};
