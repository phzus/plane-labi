# SPDX-License-Identifier: AGPL-3.0-only
# Labi modification: contract + security tests for the team chat. See LABI-CHANGES.md.
"""AC ids refer to plane-labi specs/04-funcionalidade-cliente.md."""

import json
from unittest import mock
from uuid import uuid4

import pytest
from django.conf import settings as django_settings
from rest_framework import status
from rest_framework.test import APIClient

from plane.db.models import FileAsset, User, Workspace, WorkspaceMember
from plane.messaging.models import ATTACHMENT_ENTITY_TYPE, Conversation, ConversationMember, Message

BASE = "/api/workspaces/{slug}/messages/"


@pytest.fixture(autouse=True)
def _local_cache(settings):
    # Throttles need a cache; tests must not depend on Redis.
    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}


def _user(prefix):
    uid = uuid4().hex[:8]
    return User.objects.create(
        email=f"{prefix}-{uid}@labi.test", username=f"{prefix}_{uid}", first_name=prefix.title(), display_name=prefix
    )


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def team(db, workspace, create_user):
    """owner (admin, from conftest) + bia/caio/duda members + gil guest + out (other workspace)."""
    users = {"owner": create_user}
    for name in ("bia", "caio", "duda"):
        users[name] = _user(name)
        WorkspaceMember.objects.create(workspace=workspace, member=users[name], role=15)
    users["gil"] = _user("gil")
    WorkspaceMember.objects.create(workspace=workspace, member=users["gil"], role=5)
    users["out"] = _user("out")
    other = Workspace.objects.create(name="Other", owner=users["out"], slug="other-ws")
    WorkspaceMember.objects.create(workspace=other, member=users["out"], role=20)
    return users


def _url(workspace, path=""):
    return BASE.format(slug=workspace.slug) + path


def _create(client, workspace, member_ids, **extra):
    return client.post(
        _url(workspace, "conversations/"), {"member_ids": [str(m) for m in member_ids], **extra}, format="json"
    )


def _send(client, workspace, conversation_id, body="oi", **extra):
    return client.post(
        _url(workspace, f"conversations/{conversation_id}/messages/"), {"body": body, **extra}, format="json"
    )


@pytest.mark.contract
class TestConversations:
    def test_direct_is_deduplicated(self, workspace, team):
        owner = _client(team["owner"])
        first = _create(owner, workspace, [team["bia"].id])
        assert first.status_code == status.HTTP_201_CREATED
        assert first.data["kind"] == "direct"
        again = _create(_client(team["bia"]), workspace, [team["owner"].id])
        assert again.status_code == status.HTTP_200_OK
        assert again.data["id"] == first.data["id"]
        assert Conversation.objects.filter(workspace=workspace).count() == 1

    def test_group_creator_is_admin(self, workspace, team):
        res = _create(_client(team["owner"]), workspace, [team["bia"].id, team["caio"].id], name="Criação")
        assert res.status_code == status.HTTP_201_CREATED
        assert res.data["kind"] == "group" and res.data["name"] == "Criação"
        admins = [m["id"] for m in res.data["members"] if m["is_admin"]]
        assert admins == [str(team["owner"].id)]

    def test_cannot_add_people_outside_workspace_or_guests(self, workspace, team):
        owner = _client(team["owner"])
        assert _create(owner, workspace, [team["out"].id]).status_code == status.HTTP_400_BAD_REQUEST
        assert _create(owner, workspace, [team["gil"].id]).status_code == status.HTTP_400_BAD_REQUEST
        assert _create(owner, workspace, [uuid4()]).status_code == status.HTTP_400_BAD_REQUEST
        assert _create(owner, workspace, [team["owner"].id]).status_code == status.HTTP_400_BAD_REQUEST

    def test_guest_and_outsider_have_no_access(self, workspace, team):
        assert _client(team["gil"]).get(_url(workspace, "conversations/")).status_code == status.HTTP_403_FORBIDDEN
        assert _client(team["out"]).get(_url(workspace, "conversations/")).status_code == status.HTTP_403_FORBIDDEN

    def test_list_only_shows_my_conversations(self, workspace, team):
        _create(_client(team["owner"]), workspace, [team["bia"].id])
        res = _client(team["caio"]).get(_url(workspace, "conversations/"))
        assert res.status_code == status.HTTP_200_OK and res.data == []


@pytest.mark.contract
class TestIsolation:
    """AC-2: a workspace member outside the conversation gets 404 everywhere."""

    def test_non_member_gets_404(self, workspace, team):
        conv = _create(_client(team["owner"]), workspace, [team["bia"].id, team["caio"].id]).data["id"]
        msg = _send(_client(team["owner"]), workspace, conv).data["id"]
        duda = _client(team["duda"])
        for method, path, data in [
            ("get", f"conversations/{conv}/", None),
            ("patch", f"conversations/{conv}/", {"name": "x"}),
            ("get", f"conversations/{conv}/messages/", None),
            ("post", f"conversations/{conv}/messages/", {"body": "intruso"}),
            ("delete", f"conversations/{conv}/messages/{msg}/", None),
            ("post", f"conversations/{conv}/read/", None),
            ("post", f"conversations/{conv}/members/", {"member_ids": [str(team["duda"].id)]}),
            ("post", f"conversations/{conv}/attachments/", {"name": "a.png", "type": "image/png", "size": 10}),
        ]:
            res = getattr(duda, method)(_url(workspace, path), data, format="json")
            assert res.status_code == status.HTTP_404_NOT_FOUND, (method, path, res.status_code)
        assert Message.objects.filter(conversation_id=conv).count() == 1

    def test_removed_member_loses_access(self, workspace, team):
        owner = _client(team["owner"])
        conv = _create(owner, workspace, [team["bia"].id, team["caio"].id]).data["id"]
        res = owner.delete(_url(workspace, f"conversations/{conv}/members/{team['caio'].id}/"))
        assert res.status_code == status.HTTP_204_NO_CONTENT
        caio = _client(team["caio"])
        assert caio.get(_url(workspace, f"conversations/{conv}/messages/")).status_code == status.HTTP_404_NOT_FOUND

    def test_conversation_from_other_workspace_is_404(self, workspace, team):
        conv = _create(_client(team["owner"]), workspace, [team["bia"].id]).data["id"]
        res = _client(team["out"]).get(f"/api/workspaces/other-ws/messages/conversations/{conv}/")
        assert res.status_code == status.HTTP_404_NOT_FOUND


@pytest.mark.contract
class TestMessages:
    def test_send_unread_and_read(self, workspace, team):
        owner, bia = _client(team["owner"]), _client(team["bia"])
        conv = _create(owner, workspace, [team["bia"].id]).data["id"]
        res = _send(owner, workspace, conv, "  bom dia  ")
        assert res.status_code == status.HTTP_201_CREATED and res.data["body"] == "bom dia"
        assert bia.get(_url(workspace, "unread/")).data == {"conversations": 1}
        assert owner.get(_url(workspace, "unread/")).data == {"conversations": 0}
        listed = bia.get(_url(workspace, "conversations/")).data[0]
        assert listed["unread_count"] == 1 and listed["last_message"]["body"] == "bom dia"
        assert bia.post(_url(workspace, f"conversations/{conv}/read/")).status_code == status.HTTP_200_OK
        assert bia.get(_url(workspace, "unread/")).data == {"conversations": 0}

    def test_validation(self, workspace, team):
        owner = _client(team["owner"])
        conv = _create(owner, workspace, [team["bia"].id]).data["id"]
        assert _send(owner, workspace, conv, "   ").status_code == status.HTTP_400_BAD_REQUEST
        assert _send(owner, workspace, conv, "x" * 4001).status_code == status.HTTP_400_BAD_REQUEST
        other = _create(owner, workspace, [team["caio"].id]).data["id"]
        foreign = _send(owner, workspace, other, "lá").data["id"]
        assert _send(owner, workspace, conv, "re", reply_to_id=foreign).status_code == status.HTTP_400_BAD_REQUEST

    def test_reply_and_delete_own_only(self, workspace, team):
        owner, bia = _client(team["owner"]), _client(team["bia"])
        conv = _create(owner, workspace, [team["bia"].id]).data["id"]
        first = _send(owner, workspace, conv, "pergunta").data["id"]
        reply = _send(bia, workspace, conv, "resposta", reply_to_id=first)
        assert reply.data["reply_to"]["id"] == first
        assert bia.delete(_url(workspace, f"conversations/{conv}/messages/{first}/")).status_code == 403
        res = owner.delete(_url(workspace, f"conversations/{conv}/messages/{first}/"))
        assert res.status_code == 200 and res.data["is_removed"] and res.data["body"] == ""

    def test_pagination_before(self, workspace, team):
        owner = _client(team["owner"])
        conv = _create(owner, workspace, [team["bia"].id]).data["id"]
        ids = [_send(owner, workspace, conv, f"m{i}").data["id"] for i in range(5)]
        page = owner.get(_url(workspace, f"conversations/{conv}/messages/?limit=2")).data
        assert [m["id"] for m in page["results"]] == ids[3:] and page["has_more"]
        older = owner.get(_url(workspace, f"conversations/{conv}/messages/?limit=2&before={ids[3]}")).data
        assert [m["id"] for m in older["results"]] == ids[1:3]


@pytest.mark.contract
class TestGroups:
    def test_only_admin_manages_and_heir_is_promoted(self, workspace, team):
        owner, bia = _client(team["owner"]), _client(team["bia"])
        conv = _create(owner, workspace, [team["bia"].id, team["caio"].id]).data["id"]
        assert bia.patch(_url(workspace, f"conversations/{conv}/"), {"name": "x"}, format="json").status_code == 403
        add = bia.post(
            _url(workspace, f"conversations/{conv}/members/"), {"member_ids": [str(team["duda"].id)]}, format="json"
        )
        assert add.status_code == 403
        assert bia.delete(_url(workspace, f"conversations/{conv}/members/{team['caio'].id}/")).status_code == 403
        # admin leaves -> oldest remaining member becomes admin
        assert owner.delete(_url(workspace, f"conversations/{conv}/members/{team['owner'].id}/")).status_code == 204
        assert ConversationMember.objects.filter(conversation_id=conv, is_admin=True, is_active=True).count() == 1


@pytest.mark.contract
class TestAttachments:
    def _asset(self, workspace, conv, user, uploaded=True):
        asset = FileAsset(
            attributes={"name": "f.png", "type": "image/png", "size": 10},
            asset=f"{workspace.id}/{uuid4().hex}-f.png",
            size=10,
            workspace=workspace,
            entity_type=ATTACHMENT_ENTITY_TYPE,
            entity_identifier=str(conv),
            is_uploaded=uploaded,
        )
        # BaseModel.save takes the author from the request (crum); outside a request pass it explicitly.
        asset.save(created_by_id=user.id)
        return asset

    def test_rejects_bad_type_and_size(self, workspace, team):
        owner = _client(team["owner"])
        conv = _create(owner, workspace, [team["bia"].id]).data["id"]
        url = _url(workspace, f"conversations/{conv}/attachments/")
        exe = owner.post(url, {"name": "x.exe", "type": "application/x-msdownload", "size": 10}, format="json")
        assert exe.status_code == status.HTTP_400_BAD_REQUEST
        big = owner.post(
            url, {"name": "a.png", "type": "image/png", "size": django_settings.FILE_SIZE_LIMIT + 1}, format="json"
        )
        assert big.status_code == status.HTTP_400_BAD_REQUEST

    def test_only_own_uploaded_asset_of_this_conversation(self, workspace, team):
        owner, bia = _client(team["owner"]), _client(team["bia"])
        conv = _create(owner, workspace, [team["bia"].id]).data["id"]
        other = _create(owner, workspace, [team["caio"].id]).data["id"]
        not_uploaded = self._asset(workspace, conv, team["owner"], uploaded=False)
        wrong_conv = self._asset(workspace, other, team["owner"])
        bias = self._asset(workspace, conv, team["bia"])
        for asset in (not_uploaded, wrong_conv, bias):
            res = _send(owner, workspace, conv, "", attachment_ids=[str(asset.id)])
            assert res.status_code == status.HTTP_400_BAD_REQUEST
        ok = self._asset(workspace, conv, team["owner"])
        res = _send(owner, workspace, conv, "", attachment_ids=[str(ok.id)])
        assert res.status_code == status.HTTP_201_CREATED and res.data["attachments"][0]["id"] == str(ok.id)
        # reusing an already-sent asset is refused
        assert _send(owner, workspace, conv, "", attachment_ids=[str(ok.id)]).status_code == 400
        # AC-3: members download via redirect; non-members get 404
        with mock.patch("plane.messaging.views.S3Storage") as storage:
            storage.return_value.generate_presigned_url.return_value = "https://files.test/signed"
            res = bia.get(_url(workspace, f"conversations/{conv}/attachments/{ok.id}/"))
            assert res.status_code == 302 and res["Location"] == "https://files.test/signed"
            duda = _client(team["duda"])
            assert duda.get(_url(workspace, f"conversations/{conv}/attachments/{ok.id}/")).status_code == 404


@pytest.mark.contract
class TestRealtime:
    def test_events_go_only_to_active_members(self, workspace, team, django_capture_on_commit_callbacks):
        owner = _client(team["owner"])
        conv = _create(owner, workspace, [team["bia"].id, team["caio"].id]).data["id"]
        with mock.patch("plane.messaging.realtime.redis_instance") as redis:
            with django_capture_on_commit_callbacks(execute=True):
                _send(owner, workspace, conv, "segredo")
            channel, raw = redis.return_value.publish.call_args.args
            payload = json.loads(raw)
        assert channel == "labi:messaging"
        expected = sorted(str(team[n].id) for n in ("owner", "bia", "caio"))
        assert payload["member_ids"] == expected
        assert payload["event"]["type"] == "message.created"
        assert payload["event"]["message"]["body"] == "segredo"
        assert str(team["duda"].id) not in payload["member_ids"]


@pytest.mark.contract
class TestSecurityRegressions:
    """Findings from the independent security review (2026-11-06)."""

    def _sent_asset(self, workspace, team, mime="image/png"):
        owner = _client(team["owner"])
        conv = _create(owner, workspace, [team["bia"].id, team["caio"].id]).data["id"]
        asset = FileAsset(
            attributes={"name": "f", "type": mime, "size": 10},
            asset=f"{workspace.id}/{uuid4().hex}-f",
            size=10,
            workspace=workspace,
            entity_type=ATTACHMENT_ENTITY_TYPE,
            entity_identifier=str(conv),
            is_uploaded=True,
        )
        asset.save(created_by_id=team["owner"].id)
        assert _send(owner, workspace, conv, "", attachment_ids=[str(asset.id)]).status_code == 201
        return conv, asset

    def test_svg_and_non_raster_are_never_inline(self, workspace, team):
        conv, asset = self._sent_asset(workspace, team, mime="image/svg+xml")
        with mock.patch("plane.messaging.views.S3Storage") as storage:
            storage.return_value.generate_presigned_url.return_value = "https://files.test/signed"
            _client(team["bia"]).get(_url(workspace, f"conversations/{conv}/attachments/{asset.id}/"))
            kwargs = storage.return_value.generate_presigned_url.call_args.kwargs
        assert kwargs["disposition"] == "attachment"
        assert kwargs["expiration"] <= 300

    def test_generic_asset_endpoints_cannot_reach_chat_attachments(self, workspace, team):
        conv, asset = self._sent_asset(workspace, team)
        slug = workspace.slug
        # duda is a workspace member outside the conversation; gil is a guest.
        for who in ("duda", "gil"):
            client = _client(team[who])
            for method, url in [
                ("get", f"/api/assets/v2/workspaces/{slug}/{asset.id}/"),
                ("patch", f"/api/assets/v2/workspaces/{slug}/{asset.id}/"),
                ("delete", f"/api/assets/v2/workspaces/{slug}/{asset.id}/"),
                ("get", f"/api/assets/v2/workspaces/{slug}/download/{asset.id}/"),
                ("post", f"/api/assets/v2/workspaces/{slug}/restore/{asset.id}/"),
            ]:
                res = getattr(client, method)(url, {}, format="json")
                assert res.status_code in (403, 404), (who, method, url, res.status_code)
        asset.refresh_from_db()
        assert asset.is_deleted is False

    def test_user_removed_from_workspace_gets_no_events(self, workspace, team, django_capture_on_commit_callbacks):
        owner = _client(team["owner"])
        conv = _create(owner, workspace, [team["bia"].id, team["caio"].id]).data["id"]
        WorkspaceMember.objects.filter(workspace=workspace, member=team["caio"]).update(is_active=False)
        with mock.patch("plane.messaging.realtime.redis_instance") as redis:
            with django_capture_on_commit_callbacks(execute=True):
                _send(owner, workspace, conv, "depois da saída")
            payload = json.loads(redis.return_value.publish.call_args.args[1])
        assert str(team["caio"].id) not in payload["member_ids"]

    def test_form_posts_are_rejected(self, workspace, team):
        owner = _client(team["owner"])
        conv = _create(owner, workspace, [team["bia"].id]).data["id"]
        res = owner.post(_url(workspace, f"conversations/{conv}/messages/"), {"body": "x"}, format="multipart")
        assert res.status_code == status.HTTP_415_UNSUPPORTED_MEDIA_TYPE

    def test_orphan_attachments_are_purged(self, workspace, team):
        from datetime import timedelta

        from django.utils import timezone

        from plane.messaging.tasks import delete_orphan_chat_attachments

        conv, sent = self._sent_asset(workspace, team)
        orphan = FileAsset(
            attributes={"name": "o", "type": "image/png", "size": 1},
            asset=f"{workspace.id}/{uuid4().hex}-o",
            workspace=workspace,
            entity_type=ATTACHMENT_ENTITY_TYPE,
            entity_identifier=str(conv),
            is_uploaded=True,
        )
        orphan.save(created_by_id=team["owner"].id)
        FileAsset.all_objects.filter(id__in=[orphan.id, sent.id]).update(created_at=timezone.now() - timedelta(days=2))
        with mock.patch("plane.messaging.tasks.S3Storage") as storage:
            storage.return_value.s3_client.delete_objects.return_value = {"Deleted": []}
            assert delete_orphan_chat_attachments() == 1
        assert not FileAsset.all_objects.filter(id=orphan.id).exists()
        assert FileAsset.all_objects.filter(id=sent.id).exists()

    def test_retry_with_same_client_id_does_not_duplicate(self, workspace, team):
        owner = _client(team["owner"])
        conv = _create(owner, workspace, [team["bia"].id]).data["id"]
        client_id = str(uuid4())
        first = _send(owner, workspace, conv, "uma vez", client_id=client_id)
        again = _send(owner, workspace, conv, "uma vez", client_id=client_id)
        assert first.status_code == 201 and again.status_code == 200
        assert again.data["id"] == first.data["id"] and again.data["client_id"] == client_id
        assert Message.objects.filter(conversation_id=conv).count() == 1


@pytest.mark.contract
class TestReReviewRegressions:
    """Findings from the independent re-review (2026-11-06)."""

    def test_client_id_reused_in_other_conversation_creates_new_message(self, workspace, team):
        owner = _client(team["owner"])
        first_conv = _create(owner, workspace, [team["bia"].id]).data["id"]
        second_conv = _create(owner, workspace, [team["caio"].id]).data["id"]
        client_id = str(uuid4())
        assert _send(owner, workspace, first_conv, "a", client_id=client_id).status_code == 201
        res = _send(owner, workspace, second_conv, "b", client_id=client_id)
        assert res.status_code == 201 and res.data["conversation_id"] == second_conv

    def test_raster_image_is_inline(self, workspace, team):
        owner, bia = _client(team["owner"]), _client(team["bia"])
        conv = _create(owner, workspace, [team["bia"].id]).data["id"]
        asset = FileAsset(
            attributes={"name": "p.png", "type": "image/png", "size": 10},
            asset=f"{workspace.id}/{uuid4().hex}-p.png",
            size=10,
            workspace=workspace,
            entity_type=ATTACHMENT_ENTITY_TYPE,
            entity_identifier=str(conv),
            is_uploaded=True,
        )
        asset.save(created_by_id=team["owner"].id)
        assert _send(owner, workspace, conv, "", attachment_ids=[str(asset.id)]).status_code == 201
        with mock.patch("plane.messaging.views.S3Storage") as storage:
            storage.return_value.generate_presigned_url.return_value = "https://files.test/signed"
            bia.get(_url(workspace, f"conversations/{conv}/attachments/{asset.id}/"))
            assert storage.return_value.generate_presigned_url.call_args.kwargs["disposition"] == "inline"

    def test_bulk_and_check_endpoints_ignore_chat_attachments(self, workspace, team):
        from plane.db.models import Project, ProjectMember

        owner = _client(team["owner"])
        conv = _create(owner, workspace, [team["bia"].id]).data["id"]
        asset = FileAsset(
            attributes={"name": "p.png", "type": "image/png", "size": 10},
            asset=f"{workspace.id}/{uuid4().hex}-p.png",
            size=10,
            workspace=workspace,
            entity_type=ATTACHMENT_ENTITY_TYPE,
            entity_identifier=str(conv),
            is_uploaded=True,
        )
        asset.save(created_by_id=team["owner"].id)
        project = Project.objects.create(name="P", identifier="P", workspace=workspace)
        ProjectMember.objects.create(project=project, member=team["owner"], workspace=workspace, role=20)
        owner.post(
            f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/{uuid4()}/bulk/",
            {"asset_ids": [str(asset.id)]},
            format="json",
        )
        asset.refresh_from_db()
        assert asset.project_id is None and asset.entity_type == ATTACHMENT_ENTITY_TYPE


@pytest.mark.contract
class TestPresence:
    def test_lists_only_chat_members_with_online_first(self, workspace, team):
        online_key = f"labi:presence:{team['caio'].id}".encode()
        with mock.patch("plane.messaging.views.redis_instance") as redis:
            redis.return_value.mget.side_effect = lambda keys: [
                b"1" if k.encode() == online_key else None for k in keys
            ]
            res = _client(team["bia"]).get(_url(workspace, "presence/"))
        assert res.status_code == status.HTTP_200_OK
        ids = [m["id"] for m in res.data]
        assert ids[0] == str(team["caio"].id) and res.data[0]["is_online"] is True
        assert sum(m["is_online"] for m in res.data) == 1
        # guests and people from other workspaces are never listed
        assert str(team["gil"].id) not in ids and str(team["out"].id) not in ids
        assert len(ids) == 4

    def test_last_seen_is_updated_by_the_poll_and_hidden_for_people_who_never_logged_in(self, workspace, team):
        from django.utils import timezone

        User.objects.filter(id=team["bia"].id).update(last_login=timezone.now())
        with mock.patch("plane.messaging.views.redis_instance") as redis:
            redis.return_value.mget.side_effect = lambda keys: [None for _ in keys]
            before = timezone.now()
            res = _client(team["bia"]).get(_url(workspace, "presence/"))
        by_id = {m["id"]: m for m in res.data}
        assert by_id[str(team["bia"].id)]["last_seen_at"] >= before
        assert by_id[str(team["caio"].id)]["last_seen_at"] is None

    def test_guest_and_outsider_are_refused(self, workspace, team):
        assert _client(team["gil"]).get(_url(workspace, "presence/")).status_code == status.HTTP_403_FORBIDDEN
        assert _client(team["out"]).get(_url(workspace, "presence/")).status_code == status.HTTP_403_FORBIDDEN

    def test_redis_down_shows_everyone_offline(self, workspace, team):
        with mock.patch("plane.messaging.views.redis_instance", side_effect=ConnectionError("down")):
            res = _client(team["bia"]).get(_url(workspace, "presence/"))
        assert res.status_code == 200 and not any(m["is_online"] for m in res.data)


@pytest.mark.unit
def test_kanban_migration_only_changes_list_layouts():
    import importlib

    to_kanban = importlib.import_module("plane.messaging.migrations.0002_kanban_default_layout").to_kanban
    assert to_kanban({"layout": "list", "group_by": None, "order_by": "x"}) == {
        "layout": "kanban",
        "group_by": "state",
        "order_by": "x",
    }
    assert to_kanban({"layout": "list", "group_by": "priority"})["group_by"] == "priority"
    assert to_kanban({})["layout"] == "kanban"
    assert to_kanban({"layout": "calendar"}) is None
    assert to_kanban({"layout": "kanban", "group_by": "state"}) is None


@pytest.mark.unit
def test_new_people_start_on_kanban_grouped_by_state():
    from plane.db.models import cycle, issue, module, project, view

    defaults = [m.get_default_display_filters() for m in (issue, cycle, module, view)]
    defaults.append(project.get_default_props()["display_filters"])
    for filters in defaults:
        assert filters["layout"] == "kanban" and filters["group_by"] == "state"
