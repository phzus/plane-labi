# SPDX-License-Identifier: AGPL-3.0-only
# Labi modification. See LABI-CHANGES.md.
from django.apps import AppConfig


class MessagingConfig(AppConfig):
    name = "plane.messaging"
    label = "messaging"
    default_auto_field = "django.db.models.BigAutoField"
