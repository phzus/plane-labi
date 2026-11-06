# Labi changes to Plane

This repository is a modified version of [Plane](https://github.com/makeplane/plane) (Community Edition), based on tag **v1.4.3**, licensed under the **GNU Affero General Public License v3.0** (see `LICENSE.txt`). Copyright of the original work belongs to Plane Software, Inc. and contributors. Modifications © 2026 Agência Labi and contributors, under the same license.

"Plane" is a trademark of its owners. This fork is not affiliated with or endorsed by Plane Software, Inc.

## Why this fork exists

It runs the internal project management of Agência Labi (self-hosted). Section 13 of the AGPL applies: every user of the hosted service can get the exact source code of the running version through the **"Código-fonte"** link in the app, which points to the commit deployed to production. Container images are labelled with that commit (`org.opencontainers.image.revision`).

## Modifications (all marked with `Labi modification` in the code)

| Date | Area | Files | Change |
|---|---|---|---|
| 2026-11-06 | Team chat backend | `apps/api/plane/messaging/**`, `apps/api/plane/urls.py`, `apps/api/plane/settings/common.py` | New Django app with conversations (direct and group), messages, read state and attachments; API at `/api/workspaces/<slug>/messages/`; events published on an internal Redis channel |
| 2026-11-06 | Chat attachment isolation | `apps/api/plane/app/views/asset/v2.py`, `apps/api/plane/api/views/asset.py` | Generic asset endpoints (get/patch/delete/restore/duplicate/download) exclude chat attachments, which are only served through the membership-checked chat endpoint |
| 2026-11-06 | Chat housekeeping | `apps/api/plane/messaging/tasks.py`, `apps/api/plane/celery.py` | Daily task removes chat files never sent (or from deleted messages) after 24h |
| 2026-11-06 | Team chat realtime | `apps/live/src/controllers/messages.controller.ts`, `apps/live/src/controllers/index.ts`, `apps/live/src/server.ts` | Push-only WebSocket at `/live/messages/`, session-authenticated, fail-closed origin check, per-IP pending-connection cap; WebSocket frames capped at 16 MiB |
| 2026-11-06 | Team chat UI | `apps/web/**` (files marked), `packages/i18n/src/locales/{en,pt-BR}` | "Mensagens" sidebar item, full page, and a floating chat widget |
| 2026-11-06 | Source link | `apps/web/Dockerfile.web`, web help menu | AGPL source-code link to the deployed commit |
| 2026-11-06 | CI/CD | `.github/workflows/labi-ci-cd.yml` (upstream workflows removed), `deployments/labi/deploy-labi.sh` | Tests, secret scan, images on GHCR, deploy with a restricted SSH key |
| 2026-11-06 | Tests | `apps/api/plane/tests/contract/app/test_labi_messaging.py` | Contract and access-control tests for the chat |

## Security notes for this public repository

- No secrets, server addresses or customer data are stored here. Deploy credentials live only in GitHub Actions secrets and on the server.
- Report vulnerabilities in the Labi changes privately via GitHub Security Advisories on this repository. Issues in upstream Plane belong to [makeplane/plane](https://github.com/makeplane/plane/security).
