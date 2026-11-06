# SPDX-License-Identifier: AGPL-3.0-only
# Labi modification: team chat models. See LABI-CHANGES.md.
from django.db import models
from django.db.models import Q

from plane.db.models.base import BaseModel

# Kept in its own app (and migration chain) so upstream migrations never collide.
ATTACHMENT_ENTITY_TYPE = "LABI_MESSAGE_ATTACHMENT"
MAX_BODY_LENGTH = 4000
MAX_GROUP_MEMBERS = 50
MAX_ATTACHMENTS_PER_MESSAGE = 10


class Conversation(BaseModel):
    class Kind(models.TextChoices):
        DIRECT = "direct"
        GROUP = "group"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="labi_conversations")
    kind = models.CharField(max_length=10, choices=Kind.choices)
    name = models.CharField(max_length=80, blank=True, default="")
    # "<smaller user id>:<bigger user id>" for direct conversations, so a pair never gets two threads.
    direct_key = models.CharField(max_length=80, null=True, blank=True)
    last_message_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "labi_conversations"
        ordering = ("-last_message_at", "-created_at")
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "direct_key"],
                condition=Q(direct_key__isnull=False, deleted_at__isnull=True),
                name="labi_conversation_unique_direct",
            )
        ]
        indexes = [models.Index(fields=["workspace", "last_message_at"], name="labi_conv_ws_last_idx")]


class ConversationMember(BaseModel):
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="memberships")
    member = models.ForeignKey("db.User", on_delete=models.CASCADE, related_name="labi_conversation_memberships")
    is_admin = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)
    last_read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "labi_conversation_members"
        constraints = [
            models.UniqueConstraint(fields=["conversation", "member"], name="labi_conversation_member_unique")
        ]
        indexes = [models.Index(fields=["member", "is_active"], name="labi_conv_member_active_idx")]


class Message(BaseModel):
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="messages")
    sender = models.ForeignKey("db.User", on_delete=models.SET_NULL, null=True, related_name="labi_messages")
    body = models.TextField(blank=True, default="")
    reply_to = models.ForeignKey("self", on_delete=models.SET_NULL, null=True, blank=True, related_name="replies")
    is_removed = models.BooleanField(default=False)
    attachments = models.ManyToManyField(
        "db.FileAsset", blank=True, related_name="labi_messages", db_table="labi_message_attachments"
    )

    class Meta:
        db_table = "labi_messages"
        ordering = ("created_at",)
        indexes = [models.Index(fields=["conversation", "created_at"], name="labi_msg_conv_created_idx")]
