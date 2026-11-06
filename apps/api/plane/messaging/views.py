# SPDX-License-Identifier: AGPL-3.0-only
# Labi modification: team chat API. See LABI-CHANGES.md.
"""Team chat endpoints under /api/workspaces/<slug>/messages/.

Security model (every request):
1. Session auth (BaseAPIView) + active workspace ADMIN/MEMBER (guests are external, so no chat).
2. Every conversation lookup is scoped to the workspace AND an active membership of request.user;
   anything else is a 404, so the existence of other conversations never leaks.
3. Recipients of realtime events come from the database, never from the client.
"""

import uuid
from datetime import datetime, timedelta, timezone as dt_timezone

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Count, OuterRef, Prefetch, Q, Subquery, Sum, Value
from django.db.models.functions import Coalesce
from django.http import HttpResponseRedirect
from django.utils import timezone
from rest_framework import status
from rest_framework.exceptions import NotFound, Throttled, ValidationError
from rest_framework.parsers import JSONParser
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.base import BaseAPIView
from plane.db.models import FileAsset, Workspace, WorkspaceMember
from plane.settings.storage import S3Storage

from . import realtime
from .models import ATTACHMENT_ENTITY_TYPE, MAX_GROUP_MEMBERS, Conversation, ConversationMember, Message
from .serializers import (
    AttachmentCreateInput,
    ConversationCreateInput,
    ConversationUpdateInput,
    MembersAddInput,
    MessageCreateInput,
    attachment_payload,
    conversation_payload,
    message_payload,
)

CHAT_ROLES = [ROLE.ADMIN, ROLE.MEMBER]
EPOCH = datetime(1970, 1, 1, tzinfo=dt_timezone.utc)
PAGE_SIZE = 30
MAX_PAGE_SIZE = 100


class MessageSendThrottle(UserRateThrottle):
    scope = "labi_messaging_send"
    rate = "60/minute"


class ConversationCreateThrottle(UserRateThrottle):
    scope = "labi_messaging_create"
    rate = "20/minute"


class AttachmentUploadThrottle(UserRateThrottle):
    scope = "labi_messaging_upload"
    rate = "20/minute"


# Daily per-user upload quota: protects the shared VPS disk.
UPLOAD_QUOTA_FILES_PER_DAY = 200
UPLOAD_QUOTA_BYTES_PER_DAY = 1024 * 1024 * 1024
# Only raster images are ever served inline; everything else (SVG included) downloads as attachment.
SAFE_INLINE_IMAGE_TYPES = frozenset({"image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"})
SIGNED_URL_SECONDS = 300


class ChatAPIView(BaseAPIView):
    # JSON only: blocks cross-site form/multipart posts (Plane disables CSRF for session API auth).
    parser_classes = [JSONParser]


# ---- helpers ---------------------------------------------------------------


def _validate(serializer_class, data):
    serializer = serializer_class(data=data)
    if not serializer.is_valid():
        raise ValidationError(serializer.errors)
    return serializer.validated_data


def _active_memberships_qs():
    return ConversationMember.objects.filter(is_active=True).select_related("member").order_by("created_at")


def _get_conversation(slug, conversation_id, user):
    """The only way views reach a conversation: scoped to workspace + active membership."""
    try:
        return Conversation.objects.get(
            id=conversation_id,
            workspace__slug=slug,
            memberships__member=user,
            memberships__is_active=True,
        )
    except (Conversation.DoesNotExist, ValueError):
        raise NotFound()


def _my_membership(conversation, user):
    return ConversationMember.objects.get(conversation=conversation, member=user, is_active=True)


def _active_member_ids(conversation):
    """Realtime recipients: active participants who are STILL active ADMIN/MEMBER of the workspace."""
    still_in_workspace = WorkspaceMember.objects.filter(
        workspace_id=conversation.workspace_id,
        is_active=True,
        role__gte=ROLE.MEMBER.value,
        member__is_active=True,
    ).values("member_id")
    return list(
        ConversationMember.objects.filter(
            conversation=conversation, is_active=True, member_id__in=still_in_workspace
        ).values_list("member_id", flat=True)
    )


def _chat_eligible_user_ids(slug, user_ids):
    """Active, human ADMIN/MEMBER users of this workspace among user_ids."""
    return set(
        WorkspaceMember.objects.filter(
            workspace__slug=slug,
            member_id__in=user_ids,
            is_active=True,
            role__gte=ROLE.MEMBER.value,
            member__is_bot=False,
            member__is_active=True,
        ).values_list("member_id", flat=True)
    )


def _message_qs():
    return Message.objects.select_related("reply_to").prefetch_related(
        Prefetch("attachments", queryset=FileAsset.objects.filter(is_deleted=False))
    )


def _serialize_conversation(conversation, slug, user):
    memberships = list(_active_memberships_qs().filter(conversation=conversation))
    mine = next((m for m in memberships if m.member_id == user.id), None)
    last_read = (mine.last_read_at if mine else None) or EPOCH
    last_message = _message_qs().filter(conversation=conversation).order_by("-created_at").first()
    unread = (
        Message.objects.filter(conversation=conversation, is_removed=False, created_at__gt=last_read)
        .exclude(sender_id=user.id)
        .count()
    )
    return conversation_payload(conversation, slug, memberships, last_message, unread)


def _event(slug, type_, conversation_id, **data):
    return {"type": type_, "workspace_slug": slug, "conversation_id": str(conversation_id), **data}


# ---- conversations ---------------------------------------------------------


class ConversationListEndpoint(ChatAPIView):
    def get_throttles(self):
        if self.request.method == "POST":
            return [ConversationCreateThrottle()]
        return super().get_throttles()

    @allow_permission(CHAT_ROLES, level="WORKSPACE")
    def get(self, request, slug):
        user = request.user
        mine = ConversationMember.objects.filter(
            member=user,
            is_active=True,
            conversation__workspace__slug=slug,
            conversation__deleted_at__isnull=True,
        )
        unread_sq = (
            Message.objects.filter(
                conversation_id=OuterRef("conversation_id"),
                is_removed=False,
                created_at__gt=Coalesce(OuterRef("last_read_at"), Value(EPOCH)),
            )
            .exclude(sender_id=user.id)
            .order_by()
            .values("conversation_id")
            .annotate(c=Count("id"))
            .values("c")
        )
        last_id_sq = Message.objects.filter(conversation_id=OuterRef("conversation_id")).order_by("-created_at")
        rows = list(
            mine.annotate(
                unread=Coalesce(Subquery(unread_sq), Value(0)),
                last_message_id=Subquery(last_id_sq.values("id")[:1]),
            ).select_related("conversation")
        )
        conversation_ids = [r.conversation_id for r in rows]
        members_by_conv = {}
        for m in _active_memberships_qs().filter(conversation_id__in=conversation_ids):
            members_by_conv.setdefault(m.conversation_id, []).append(m)
        last_messages = {
            m.id: m for m in _message_qs().filter(id__in=[r.last_message_id for r in rows if r.last_message_id])
        }
        rows.sort(key=lambda r: r.conversation.last_message_at or r.conversation.created_at, reverse=True)
        data = [
            conversation_payload(
                r.conversation,
                slug,
                members_by_conv.get(r.conversation_id, []),
                last_messages.get(r.last_message_id),
                r.unread,
            )
            for r in rows
        ]
        return Response(data, status=status.HTTP_200_OK)

    @allow_permission(CHAT_ROLES, level="WORKSPACE")
    def post(self, request, slug):
        user = request.user
        payload = _validate(ConversationCreateInput, request.data)
        other_ids = {mid for mid in payload["member_ids"] if mid != user.id}
        if not other_ids:
            raise ValidationError({"member_ids": "Escolha pelo menos uma pessoa."})
        if _chat_eligible_user_ids(slug, other_ids) != other_ids:
            raise ValidationError({"member_ids": "Pessoa inválida para este workspace."})
        workspace = Workspace.objects.get(slug=slug)
        name = payload.get("name", "")
        is_group = payload.get("is_group") or len(other_ids) > 1 or bool(name)

        if not is_group:
            other_id = next(iter(other_ids))
            direct_key = ":".join(sorted([str(user.id), str(other_id)]))
            existing = Conversation.objects.filter(workspace=workspace, direct_key=direct_key).first()
            if existing:
                # Reactivate memberships if someone had left a direct thread.
                ConversationMember.objects.filter(conversation=existing).update(is_active=True)
                return Response(_serialize_conversation(existing, slug, user), status=status.HTTP_200_OK)
            try:
                with transaction.atomic():
                    conversation = Conversation.objects.create(
                        workspace=workspace, kind=Conversation.Kind.DIRECT, direct_key=direct_key
                    )
                    ConversationMember.objects.bulk_create(
                        [
                            ConversationMember(conversation=conversation, member_id=user.id),
                            ConversationMember(conversation=conversation, member_id=other_id),
                        ]
                    )
            except IntegrityError:  # concurrent create of the same pair
                existing = Conversation.objects.get(workspace=workspace, direct_key=direct_key)
                return Response(_serialize_conversation(existing, slug, user), status=status.HTTP_200_OK)
        else:
            with transaction.atomic():
                conversation = Conversation.objects.create(workspace=workspace, kind=Conversation.Kind.GROUP, name=name)
                ConversationMember.objects.bulk_create(
                    [ConversationMember(conversation=conversation, member_id=user.id, is_admin=True)]
                    + [ConversationMember(conversation=conversation, member_id=mid) for mid in other_ids]
                )

        data = _serialize_conversation(conversation, slug, user)
        realtime.publish(_active_member_ids(conversation), _event(slug, "conversation.created", conversation.id))
        return Response(data, status=status.HTTP_201_CREATED)


class ConversationDetailEndpoint(ChatAPIView):
    @allow_permission(CHAT_ROLES, level="WORKSPACE")
    def get(self, request, slug, conversation_id):
        conversation = _get_conversation(slug, conversation_id, request.user)
        return Response(_serialize_conversation(conversation, slug, request.user), status=status.HTTP_200_OK)

    @allow_permission(CHAT_ROLES, level="WORKSPACE")
    def patch(self, request, slug, conversation_id):
        conversation = _get_conversation(slug, conversation_id, request.user)
        if conversation.kind != Conversation.Kind.GROUP or not _my_membership(conversation, request.user).is_admin:
            return Response({"error": "Somente quem administra o grupo pode renomear."}, status=403)
        payload = _validate(ConversationUpdateInput, request.data)
        conversation.name = payload["name"]
        conversation.save(update_fields=["name", "updated_at"])
        realtime.publish(_active_member_ids(conversation), _event(slug, "conversation.updated", conversation.id))
        return Response(_serialize_conversation(conversation, slug, request.user), status=status.HTTP_200_OK)


class ConversationMembersEndpoint(ChatAPIView):
    @allow_permission(CHAT_ROLES, level="WORKSPACE")
    def post(self, request, slug, conversation_id):
        conversation = _get_conversation(slug, conversation_id, request.user)
        if conversation.kind != Conversation.Kind.GROUP or not _my_membership(conversation, request.user).is_admin:
            return Response({"error": "Somente quem administra o grupo pode adicionar pessoas."}, status=403)
        payload = _validate(MembersAddInput, request.data)
        new_ids = set(payload["member_ids"])
        if _chat_eligible_user_ids(slug, new_ids) != new_ids:
            raise ValidationError({"member_ids": "Pessoa inválida para este workspace."})
        with transaction.atomic():
            Conversation.objects.select_for_update().get(id=conversation.id)
            current = set(
                ConversationMember.objects.filter(conversation=conversation, is_active=True).values_list(
                    "member_id", flat=True
                )
            )
            if len(current | new_ids) > MAX_GROUP_MEMBERS:
                raise ValidationError({"member_ids": f"Grupo limitado a {MAX_GROUP_MEMBERS} pessoas."})
            for member_id in new_ids - current:
                ConversationMember.objects.update_or_create(
                    conversation=conversation,
                    member_id=member_id,
                    defaults={"is_active": True, "is_admin": False, "created_at": timezone.now()},
                )
        realtime.publish(_active_member_ids(conversation), _event(slug, "conversation.updated", conversation.id))
        return Response(_serialize_conversation(conversation, slug, request.user), status=status.HTTP_200_OK)

    @allow_permission(CHAT_ROLES, level="WORKSPACE")
    def delete(self, request, slug, conversation_id, member_id):
        conversation = _get_conversation(slug, conversation_id, request.user)
        me = _my_membership(conversation, request.user)
        leaving = str(member_id) == str(request.user.id)
        if conversation.kind != Conversation.Kind.GROUP:
            return Response({"error": "Conversas diretas não têm membros removíveis."}, status=400)
        if not leaving and not me.is_admin:
            return Response({"error": "Somente quem administra o grupo pode remover pessoas."}, status=403)
        before = _active_member_ids(conversation)
        with transaction.atomic():
            Conversation.objects.select_for_update().get(id=conversation.id)
            target = ConversationMember.objects.filter(
                conversation=conversation, member_id=member_id, is_active=True
            ).first()
            if target is None:
                raise NotFound()
            target.is_active = False
            target.is_admin = False
            target.save(update_fields=["is_active", "is_admin", "updated_at"])
            remaining = ConversationMember.objects.filter(conversation=conversation, is_active=True)
            if remaining.exists() and not remaining.filter(is_admin=True).exists():
                heir = remaining.order_by("created_at").first()
                heir.is_admin = True
                heir.save(update_fields=["is_admin", "updated_at"])
        realtime.publish(before, _event(slug, "conversation.updated", conversation.id))
        return Response(status=status.HTTP_204_NO_CONTENT)


class ConversationReadEndpoint(ChatAPIView):
    @allow_permission(CHAT_ROLES, level="WORKSPACE")
    def post(self, request, slug, conversation_id):
        conversation = _get_conversation(slug, conversation_id, request.user)
        now = timezone.now()
        ConversationMember.objects.filter(conversation=conversation, member=request.user).update(last_read_at=now)
        realtime.publish(
            _active_member_ids(conversation),
            _event(slug, "conversation.read", conversation.id, user_id=str(request.user.id), last_read_at=now),
        )
        return Response({"last_read_at": now}, status=status.HTTP_200_OK)


class UnreadSummaryEndpoint(ChatAPIView):
    @allow_permission(CHAT_ROLES, level="WORKSPACE")
    def get(self, request, slug):
        user = request.user
        unread_exists = (
            Message.objects.filter(
                conversation_id=OuterRef("conversation_id"),
                is_removed=False,
                created_at__gt=Coalesce(OuterRef("last_read_at"), Value(EPOCH)),
            )
            .exclude(sender_id=user.id)
            .values("id")[:1]
        )
        total = (
            ConversationMember.objects.filter(
                member=user, is_active=True, conversation__workspace__slug=slug, conversation__deleted_at__isnull=True
            )
            .annotate(first_unread=Subquery(unread_exists))
            .filter(first_unread__isnull=False)
            .count()
        )
        return Response({"conversations": total}, status=status.HTTP_200_OK)


# ---- messages ----------------------------------------------------------------


class MessageListEndpoint(ChatAPIView):
    def get_throttles(self):
        if self.request.method == "POST":
            return [MessageSendThrottle()]
        return super().get_throttles()

    @allow_permission(CHAT_ROLES, level="WORKSPACE")
    def get(self, request, slug, conversation_id):
        conversation = _get_conversation(slug, conversation_id, request.user)
        try:
            limit = max(1, min(int(request.GET.get("limit", PAGE_SIZE)), MAX_PAGE_SIZE))
        except ValueError:
            limit = PAGE_SIZE
        qs = _message_qs().filter(conversation=conversation)
        before = request.GET.get("before")
        if before:
            try:
                anchor = Message.objects.get(id=uuid.UUID(before), conversation=conversation)
            except (Message.DoesNotExist, ValueError):
                raise NotFound()
            qs = qs.filter(Q(created_at__lt=anchor.created_at) | Q(created_at=anchor.created_at, id__lt=anchor.id))
        page = list(qs.order_by("-created_at", "-id")[: limit + 1])
        has_more = len(page) > limit
        page = list(reversed(page[:limit]))
        return Response(
            {"results": [message_payload(m, slug) for m in page], "has_more": has_more}, status=status.HTTP_200_OK
        )

    @allow_permission(CHAT_ROLES, level="WORKSPACE")
    def post(self, request, slug, conversation_id):
        user = request.user
        conversation = _get_conversation(slug, conversation_id, user)
        payload = _validate(MessageCreateInput, request.data)
        client_id = payload.get("client_id")
        if client_id:
            existing = _message_qs().filter(conversation=conversation, sender=user, client_id=client_id).first()
            if existing:  # retried send: return the original, never duplicate
                return Response(message_payload(existing, slug), status=status.HTTP_200_OK)

        reply_to = None
        if payload.get("reply_to_id"):
            reply_to = Message.objects.filter(id=payload["reply_to_id"], conversation=conversation).first()
            if reply_to is None:
                raise ValidationError({"reply_to_id": "Mensagem não encontrada nesta conversa."})

        attachment_ids = set(payload.get("attachment_ids") or [])
        try:
            with transaction.atomic():
                assets = list(
                    FileAsset.objects.select_for_update(of=("self",)).filter(
                        id__in=attachment_ids,
                        workspace=conversation.workspace,
                        entity_type=ATTACHMENT_ENTITY_TYPE,
                        entity_identifier=str(conversation.id),
                        created_by=user,
                        is_uploaded=True,
                        is_deleted=False,
                        labi_messages__isnull=True,
                    )
                )
                already_sent = Message.attachments.through.objects.filter(fileasset_id__in=attachment_ids).exists()
                if len(assets) != len(attachment_ids) or already_sent:
                    raise ValidationError({"attachment_ids": "Anexo inválido."})
                message = Message.objects.create(
                    conversation=conversation,
                    sender=user,
                    body=payload.get("body", ""),
                    reply_to=reply_to,
                    client_id=client_id,
                )
                if assets:
                    message.attachments.set(assets)
                Conversation.objects.filter(id=conversation.id).update(last_message_at=message.created_at)
                ConversationMember.objects.filter(conversation=conversation, member=user).update(
                    last_read_at=message.created_at
                )
        except IntegrityError:  # concurrent retry with the same client_id won the race
            existing = _message_qs().get(conversation=conversation, sender=user, client_id=client_id)
            return Response(message_payload(existing, slug), status=status.HTTP_200_OK)
        message = _message_qs().get(id=message.id)
        data = message_payload(message, slug)
        realtime.publish(
            _active_member_ids(conversation), _event(slug, "message.created", conversation.id, message=data)
        )
        return Response(data, status=status.HTTP_201_CREATED)


class MessageDetailEndpoint(ChatAPIView):
    @allow_permission(CHAT_ROLES, level="WORKSPACE")
    def delete(self, request, slug, conversation_id, message_id):
        conversation = _get_conversation(slug, conversation_id, request.user)
        message = Message.objects.filter(id=message_id, conversation=conversation).first()
        if message is None:
            raise NotFound()
        if message.sender_id != request.user.id:
            return Response({"error": "Só é possível apagar as próprias mensagens."}, status=403)
        with transaction.atomic():
            FileAsset.objects.filter(labi_messages=message).update(is_deleted=True, deleted_at=timezone.now())
            message.is_removed = True
            message.body = ""
            message.save(update_fields=["is_removed", "body", "updated_at"])
        data = message_payload(_message_qs().get(id=message.id), slug)
        realtime.publish(
            _active_member_ids(conversation), _event(slug, "message.updated", conversation.id, message=data)
        )
        return Response(data, status=status.HTTP_200_OK)


# ---- attachments ---------------------------------------------------------------


class AttachmentEndpoint(ChatAPIView):
    def get_throttles(self):
        return [AttachmentUploadThrottle()]

    @allow_permission(CHAT_ROLES, level="WORKSPACE")
    def post(self, request, slug, conversation_id):
        conversation = _get_conversation(slug, conversation_id, request.user)
        payload = _validate(AttachmentCreateInput, request.data)
        recent = FileAsset.all_objects.filter(
            entity_type=ATTACHMENT_ENTITY_TYPE,
            created_by=request.user,
            created_at__gte=timezone.now() - timedelta(days=1),
        ).aggregate(files=Count("id"), size=Coalesce(Sum("size"), Value(0.0)))
        if (
            recent["files"] >= UPLOAD_QUOTA_FILES_PER_DAY
            or recent["size"] + payload["size"] > UPLOAD_QUOTA_BYTES_PER_DAY
        ):
            raise Throttled(detail="Limite diário de anexos atingido.")
        workspace = conversation.workspace
        asset_key = f"{workspace.id}/{uuid.uuid4().hex}-{payload['name']}"
        size = min(payload["size"], settings.FILE_SIZE_LIMIT)
        asset = FileAsset.objects.create(
            attributes={"name": payload["name"], "type": payload["type"], "size": size},
            asset=asset_key,
            size=size,
            workspace=workspace,
            created_by=request.user,
            entity_type=ATTACHMENT_ENTITY_TYPE,
            entity_identifier=str(conversation.id),
        )
        storage = S3Storage(request=request)
        upload_data = storage.generate_presigned_post(object_name=asset_key, file_type=payload["type"], file_size=size)
        return Response(
            {
                "upload_data": upload_data,
                "asset_id": str(asset.id),
                "attachment": attachment_payload(asset, slug, conversation.id),
            },
            status=status.HTTP_200_OK,
        )


class AttachmentDetailEndpoint(ChatAPIView):
    def _asset(self, slug, conversation, asset_id):
        try:
            return FileAsset.objects.get(
                id=asset_id,
                workspace__slug=slug,
                entity_type=ATTACHMENT_ENTITY_TYPE,
                entity_identifier=str(conversation.id),
                is_deleted=False,
            )
        except (FileAsset.DoesNotExist, ValueError):
            raise NotFound()

    @allow_permission(CHAT_ROLES, level="WORKSPACE")
    def patch(self, request, slug, conversation_id, asset_id):
        conversation = _get_conversation(slug, conversation_id, request.user)
        asset = self._asset(slug, conversation, asset_id)
        if asset.created_by_id != request.user.id:
            raise NotFound()
        asset.is_uploaded = True
        asset.save(update_fields=["is_uploaded", "updated_at"])
        return Response(status=status.HTTP_204_NO_CONTENT)

    @allow_permission(CHAT_ROLES, level="WORKSPACE")
    def get(self, request, slug, conversation_id, asset_id):
        conversation = _get_conversation(slug, conversation_id, request.user)
        asset = self._asset(slug, conversation, asset_id)
        sent_here = asset.labi_messages.filter(conversation=conversation, is_removed=False).exists()
        if not asset.is_uploaded or not (sent_here or asset.created_by_id == request.user.id):
            raise NotFound()
        name = (asset.attributes or {}).get("name") or "arquivo"
        mime = (asset.attributes or {}).get("type") or ""
        inline = mime.split(";")[0].strip().lower() in SAFE_INLINE_IMAGE_TYPES and request.GET.get("download") != "1"
        storage = S3Storage(request=request)
        url = storage.generate_presigned_url(
            object_name=asset.asset.name,
            expiration=SIGNED_URL_SECONDS,
            disposition="inline" if inline else "attachment",
            filename=name,
        )
        if not url:
            raise NotFound()
        return HttpResponseRedirect(url)
