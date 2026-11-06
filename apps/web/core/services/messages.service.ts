/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */
// Labi modification: team chat (see LABI-CHANGES.md)

import type { AxiosRequestConfig } from "axios";
import { API_BASE_URL } from "@plane/constants";
import { generateFileUploadPayload, getFileMetaDataForUpload } from "@plane/services";
import type { TFileSignedURLResponse } from "@plane/types";
// services
import { APIService } from "@/services/api.service";
import { FileUploadService } from "@/services/file-upload.service";

export type TChatAttachment = { id: string; name: string; type: string; size: number; url: string };

export type TChatMessage = {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  body: string;
  is_removed: boolean;
  reply_to: { id: string; sender_id: string | null; body: string; is_removed: boolean } | null;
  attachments: TChatAttachment[];
  created_at: string;
  /** Idempotency key sent by the author's client (echoed back by the server). */
  client_id?: string | null;
  // client-only (optimistic send)
  client_status?: "pending" | "failed";
  client_error_status?: number;
  client_payload?: TSendMessagePayload;
};

export type TChatMember = {
  id: string;
  display_name: string;
  first_name: string;
  last_name: string;
  avatar_url: string;
  is_admin: boolean;
  last_read_at: string | null;
};

export type TConversation = {
  id: string;
  kind: "direct" | "group";
  name: string;
  members: TChatMember[];
  last_message: TChatMessage | null;
  last_message_at: string | null;
  unread_count: number;
  created_at: string;
};

export type TSendMessagePayload = {
  body?: string;
  reply_to_id?: string | null;
  attachment_ids?: string[];
  client_id?: string;
};

const EXT_MIME: Record<string, string> = {
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};

/** Browsers sometimes leave File.type empty (e.g. .txt on some OSes): fall back to the extension. */
export const inferMimeType = (file: File): string =>
  file.type || EXT_MIME[file.name.split(".").pop()?.toLowerCase() ?? ""] || "";

export class MessagesService extends APIService {
  private fileUploadService = new FileUploadService();

  constructor() {
    super(API_BASE_URL);
  }

  private base(slug: string) {
    return `/api/workspaces/${slug}/messages`;
  }

  async listConversations(slug: string): Promise<TConversation[]> {
    return this.get(`${this.base(slug)}/conversations/`).then((r) => r.data);
  }

  async getConversation(slug: string, id: string): Promise<TConversation> {
    return this.get(`${this.base(slug)}/conversations/${id}/`).then((r) => r.data);
  }

  async createConversation(slug: string, data: { member_ids: string[]; name?: string }): Promise<TConversation> {
    return this.post(`${this.base(slug)}/conversations/`, data).then((r) => r.data);
  }

  async renameConversation(slug: string, id: string, name: string): Promise<TConversation> {
    return this.patch(`${this.base(slug)}/conversations/${id}/`, { name }).then((r) => r.data);
  }

  async addMembers(slug: string, id: string, member_ids: string[]): Promise<TConversation> {
    return this.post(`${this.base(slug)}/conversations/${id}/members/`, { member_ids }).then((r) => r.data);
  }

  async removeMember(slug: string, id: string, userId: string): Promise<void> {
    await this.delete(`${this.base(slug)}/conversations/${id}/members/${userId}/`);
  }

  async markRead(slug: string, id: string): Promise<{ last_read_at: string }> {
    return this.post(`${this.base(slug)}/conversations/${id}/read/`).then((r) => r.data);
  }

  async listMessages(
    slug: string,
    id: string,
    before?: string
  ): Promise<{ results: TChatMessage[]; has_more: boolean }> {
    return this.get(`${this.base(slug)}/conversations/${id}/messages/`, {
      params: { limit: 30, ...(before ? { before } : {}) },
    }).then((r) => r.data);
  }

  async sendMessage(slug: string, id: string, data: TSendMessagePayload): Promise<TChatMessage> {
    return this.post(`${this.base(slug)}/conversations/${id}/messages/`, data).then((r) => r.data);
  }

  async deleteMessage(slug: string, id: string, messageId: string): Promise<TChatMessage> {
    return this.delete(`${this.base(slug)}/conversations/${id}/messages/${messageId}/`).then((r) => r.data);
  }

  /** Same three steps as issue attachments: request signed upload, upload to storage, confirm. */
  async uploadAttachment(
    slug: string,
    id: string,
    file: File,
    onUploadProgress?: AxiosRequestConfig["onUploadProgress"]
  ): Promise<TChatAttachment> {
    const meta = await getFileMetaDataForUpload(file);
    const type = meta.type || inferMimeType(file);
    const { data } = await this.post(`${this.base(slug)}/conversations/${id}/attachments/`, {
      name: file.name,
      size: file.size,
      type,
    });
    const signed = data as TFileSignedURLResponse & { attachment: TChatAttachment };
    await this.fileUploadService.uploadFile(
      signed.upload_data.url,
      generateFileUploadPayload(signed, file),
      onUploadProgress
    );
    await this.patch(`${this.base(slug)}/conversations/${id}/attachments/${signed.asset_id}/`);
    return signed.attachment;
  }
}
