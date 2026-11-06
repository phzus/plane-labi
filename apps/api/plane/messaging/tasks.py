# SPDX-License-Identifier: AGPL-3.0-only
# Labi modification: housekeeping for team chat attachments. See LABI-CHANGES.md.
from datetime import timedelta

from celery import shared_task
from django.db.models import Q
from django.utils import timezone

from plane.db.models import FileAsset
from plane.settings.storage import S3Storage

from .models import ATTACHMENT_ENTITY_TYPE

ORPHAN_AFTER = timedelta(hours=24)
BATCH = 500  # S3 DeleteObjects accepts up to 1000 keys per call


@shared_task
def delete_orphan_chat_attachments():
    """Remove chat files never sent in a message, or belonging to deleted messages, after 24h.

    Frees disk on the shared server (uploads are otherwise kept forever).
    """
    stale = FileAsset.all_objects.filter(
        Q(labi_messages__isnull=True) | Q(is_deleted=True),
        entity_type=ATTACHMENT_ENTITY_TYPE,
        created_at__lt=timezone.now() - ORPHAN_AFTER,
    ).distinct()
    storage = S3Storage(request=None)
    removed = 0
    while True:
        batch = list(stale.values_list("id", "asset")[:BATCH])
        if not batch:
            break
        ids, keys = zip(*batch)
        if not storage.delete_files([str(key) for key in keys if key]):
            break  # storage error already logged; retry tomorrow, keep the rows
        FileAsset.all_objects.filter(id__in=ids).delete()
        removed += len(ids)
    return removed
