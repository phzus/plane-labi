# SPDX-License-Identifier: AGPL-3.0-only
# Labi modification: fan-out of chat events to the live server. See LABI-CHANGES.md.
"""Publishes chat events on an internal Redis channel; apps/live delivers them over WebSocket.

The recipient list is always computed here (server side, from active memberships), never by the client.
Delivery is best effort: the database is the source of truth and clients resync on reconnect.
"""

import json

from django.core.serializers.json import DjangoJSONEncoder
from django.db import transaction

from plane.settings.redis import redis_instance
from plane.utils.exception_logger import log_exception

CHANNEL = "labi:messaging"


def publish(member_ids, event):
    payload = json.dumps(
        {"member_ids": sorted({str(member_id) for member_id in member_ids}), "event": event},
        cls=DjangoJSONEncoder,
    )

    def _send():
        try:
            redis_instance().publish(CHANNEL, payload)
        except Exception as exc:  # never break the request because of the push channel
            log_exception(exc)

    transaction.on_commit(_send)
