# Labi modification: seed for the disposable E2E stack (run by run.sh through `manage.py shell`).
# run.sh prepends `E2E_USERS = {...}` (throwaway passwords generated at runtime) to this file on stdin.
import uuid

from django.core.cache import cache
from django.db import transaction
from django.utils import timezone

from plane.db.models import Profile, User, Workspace, WorkspaceMember
from plane.license.models import Instance, InstanceConfiguration

SLUG = "labi-e2e"
ONBOARDED = {"profile_complete": True, "workspace_create": True, "workspace_invite": True, "workspace_join": True}

with transaction.atomic():
    instance = Instance.objects.select_for_update().get()
    instance.instance_name = "Labi E2E"
    instance.is_setup_done = True
    instance.is_telemetry_enabled = False
    instance.is_support_required = False
    instance.save()
    for key, value in {"ENABLE_SIGNUP": "0", "ENABLE_MAGIC_LINK_LOGIN": "0", "ENABLE_EMAIL_PASSWORD": "1"}.items():
        assert InstanceConfiguration.objects.filter(key=key).update(value=value) == 1, key

    users = {}
    for name, spec in E2E_USERS.items():  # noqa: F821 (prepended by run.sh)
        user = User(
            email=spec["email"],
            username=uuid.uuid4().hex,
            first_name=spec["first_name"],
            last_name="Teste",
            display_name=name,
            is_password_autoset=False,
            is_email_verified=True,
            user_timezone="America/Sao_Paulo",
            token_updated_at=timezone.now(),
        )
        user.set_password(spec["password"])
        user.save()
        users[name] = user

    workspace = Workspace.objects.create(name="Labi E2E", slug=SLUG, owner=users["ana"])
    for name, spec in E2E_USERS.items():  # noqa: F821
        WorkspaceMember.objects.create(workspace=workspace, member=users[name], role=spec["role"])
        Profile.objects.update_or_create(
            user=users[name],
            defaults={
                "is_onboarded": True,
                "onboarding_step": ONBOARDED,
                "last_workspace_id": workspace.id,
                "language": "pt-BR",
                "is_tour_completed": True,
                "is_navigation_tour_completed": True,
                "billing_address_country": "BRAZIL",
                "company_name": "Labi",
                "start_of_the_week": 1,
            },
        )

cache.clear()
print(f"SEED_OK workspace={SLUG} users={len(users)}")
