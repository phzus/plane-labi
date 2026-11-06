# SPDX-License-Identifier: AGPL-3.0-only
# Labi modification: team chat routes, mounted at /api/workspaces/<slug>/messages/. See LABI-CHANGES.md.
from django.urls import path

from . import views

urlpatterns = [
    path("unread/", views.UnreadSummaryEndpoint.as_view(), name="labi-messaging-unread"),
    path("conversations/", views.ConversationListEndpoint.as_view(), name="labi-messaging-conversations"),
    path(
        "conversations/<uuid:conversation_id>/",
        views.ConversationDetailEndpoint.as_view(),
        name="labi-messaging-conversation",
    ),
    path(
        "conversations/<uuid:conversation_id>/members/",
        views.ConversationMembersEndpoint.as_view(),
        name="labi-messaging-members",
    ),
    path(
        "conversations/<uuid:conversation_id>/members/<uuid:member_id>/",
        views.ConversationMembersEndpoint.as_view(),
        name="labi-messaging-member",
    ),
    path(
        "conversations/<uuid:conversation_id>/read/",
        views.ConversationReadEndpoint.as_view(),
        name="labi-messaging-read",
    ),
    path(
        "conversations/<uuid:conversation_id>/messages/",
        views.MessageListEndpoint.as_view(),
        name="labi-messaging-messages",
    ),
    path(
        "conversations/<uuid:conversation_id>/messages/<uuid:message_id>/",
        views.MessageDetailEndpoint.as_view(),
        name="labi-messaging-message",
    ),
    path(
        "conversations/<uuid:conversation_id>/attachments/",
        views.AttachmentEndpoint.as_view(),
        name="labi-messaging-attachments",
    ),
    path(
        "conversations/<uuid:conversation_id>/attachments/<uuid:asset_id>/",
        views.AttachmentDetailEndpoint.as_view(),
        name="labi-messaging-attachment",
    ),
]
