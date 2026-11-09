# SPDX-License-Identifier: AGPL-3.0-only
# Labi modification: everyone starts on Kanban. See LABI-CHANGES.md.
from django.db import migrations

USER_PROPERTY_MODELS = ("ProjectUserProperty", "CycleUserProperties", "ModuleUserProperties")


def to_kanban(display_filters):
    """Returns the new filters for a saved "list" (or unset) layout, or None when there is nothing to change."""
    if (display_filters or {}).get("layout") not in ("list", None):
        return None
    return {**(display_filters or {}), "layout": "kanban", "group_by": (display_filters or {}).get("group_by") or "state"}


def apply(apps, schema_editor):
    for name in USER_PROPERTY_MODELS:
        model = apps.get_model("db", name)
        changed = []
        for row in model.objects.all().iterator():
            updated = to_kanban(row.display_filters)
            if updated is not None:
                row.display_filters = updated
                changed.append(row)
        model.objects.bulk_update(changed, ["display_filters"], batch_size=200)


class Migration(migrations.Migration):
    dependencies = [("messaging", "0001_initial")]

    operations = [migrations.RunPython(apply, migrations.RunPython.noop)]
