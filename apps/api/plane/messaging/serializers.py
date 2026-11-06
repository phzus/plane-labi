# SPDX-License-Identifier: AGPL-3.0-only
# Labi modification: team chat input validation and output shapes. See LABI-CHANGES.md.
from django.conf import settings
from rest_framework import serializers

from plane.utils.path_validator import sanitize_filename

from .models import MAX_ATTACHMENTS_PER_MESSAGE, MAX_BODY_LENGTH, MAX_GROUP_MEMBERS


# ---- input ---------------------------------------------------------------


class ConversationCreateInput(serializers.Serializer):
    member_ids = serializers.ListField(child=serializers.UUIDField(), min_length=1, max_length=MAX_GROUP_MEMBERS - 1)
    name = serializers.CharField(max_length=80, required=False, allow_blank=True, trim_whitespace=True)
    is_group = serializers.BooleanField(required=False, default=False)


class ConversationUpdateInput(serializers.Serializer):
    name = serializers.CharField(max_length=80, allow_blank=True, trim_whitespace=True)


class MembersAddInput(serializers.Serializer):
    member_ids = serializers.ListField(child=serializers.UUIDField(), min_length=1, max_length=MAX_GROUP_MEMBERS - 1)


class MessageCreateInput(serializers.Serializer):
    body = serializers.CharField(
        max_length=MAX_BODY_LENGTH, required=False, allow_blank=True, trim_whitespace=True, default=""
    )
    reply_to_id = serializers.UUIDField(required=False, allow_null=True)
    client_id = serializers.UUIDField(required=False, allow_null=True)
    attachment_ids = serializers.ListField(
        child=serializers.UUIDField(), required=False, default=list, max_length=MAX_ATTACHMENTS_PER_MESSAGE
    )

    def validate(self, attrs):
        if not attrs.get("body") and not attrs.get("attachment_ids"):
            raise serializers.ValidationError("Mensagem vazia.")
        return attrs


class AttachmentCreateInput(serializers.Serializer):
    name = serializers.CharField(max_length=255)
    type = serializers.CharField(max_length=255)
    size = serializers.IntegerField(min_value=1)

    def validate_name(self, value):
        return sanitize_filename(value) or "arquivo"

    def validate_type(self, value):
        if value not in settings.ATTACHMENT_MIME_TYPES:
            raise serializers.ValidationError("Tipo de arquivo não permitido.")
        return value

    def validate_size(self, value):
        if value > settings.FILE_SIZE_LIMIT:
            raise serializers.ValidationError("Arquivo acima do limite.")
        return value


# ---- output --------------------------------------------------------------


def user_payload(user):
    if user is None:
        return None
    return {
        "id": str(user.id),
        "display_name": user.display_name,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "avatar_url": user.avatar_url,
    }


def attachment_payload(asset, slug, conversation_id):
    attributes = asset.attributes or {}
    return {
        "id": str(asset.id),
        "name": attributes.get("name") or "arquivo",
        "type": attributes.get("type") or "",
        "size": asset.size,
        "url": f"/api/workspaces/{slug}/messages/conversations/{conversation_id}/attachments/{asset.id}/",
    }


def message_payload(message, slug):
    reply = message.reply_to
    return {
        "id": str(message.id),
        "conversation_id": str(message.conversation_id),
        "sender_id": str(message.sender_id) if message.sender_id else None,
        "body": "" if message.is_removed else message.body,
        "is_removed": message.is_removed,
        "client_id": str(message.client_id) if message.client_id else None,
        "reply_to": (
            {
                "id": str(reply.id),
                "sender_id": str(reply.sender_id) if reply.sender_id else None,
                "body": "" if reply.is_removed else reply.body[:200],
                "is_removed": reply.is_removed,
            }
            if reply
            else None
        ),
        "attachments": []
        if message.is_removed
        else [attachment_payload(a, slug, message.conversation_id) for a in message.attachments.all()],
        "created_at": message.created_at,
    }


def conversation_payload(conversation, slug, memberships, last_message=None, unread_count=0):
    return {
        "id": str(conversation.id),
        "kind": conversation.kind,
        "name": conversation.name,
        "members": [
            {
                **user_payload(m.member),
                "is_admin": m.is_admin,
                "last_read_at": m.last_read_at,
            }
            for m in memberships
        ],
        "last_message": message_payload(last_message, slug) if last_message else None,
        "last_message_at": conversation.last_message_at,
        "unread_count": unread_count,
        "created_at": conversation.created_at,
    }
