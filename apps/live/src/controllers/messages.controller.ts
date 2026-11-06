/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Labi modification: realtime delivery for the team chat (Mensagens). See LABI-CHANGES.md.
 *
 * Push-only WebSocket at `${LIVE_BASE_PATH}/messages/`.
 * - Auth: the browser's Plane session cookie, validated against the API (same as collaboration).
 * - Origin must be one of CORS_ALLOWED_ORIGINS (blocks cross-site WebSocket hijacking).
 * - Events come from the API through the internal Redis channel; the API computes the recipients.
 *   This server never accepts data from clients and never decides who may read what.
 */
import type { Request } from "express";
import type Redis from "ioredis";
import type WebSocket from "ws";
// plane imports
import { Controller, WebSocket as WSDecorator } from "@plane/decorators";
import { logger } from "@plane/logger";
// env
import { env } from "@/env";
// redis
import { redisManager } from "@/redis";
// services
import { UserService } from "@/services/user.service";

const CHANNEL = "labi:messaging";
const HEARTBEAT_MS = 30_000;
const REVALIDATE_MS = 10 * 60_000;
const MAX_SOCKETS_PER_USER = 10;
const MAX_CLIENT_FRAME_BYTES = 1024;

type TClient = { ws: WebSocket; userId: string; cookie: string; alive: boolean; validatedAt: number };

class MessagingHub {
  private readonly clients = new Map<string, Set<TClient>>();
  private subscriber: Redis | null = null;
  private starting: Promise<void> | null = null;

  start(): Promise<void> {
    if (!this.starting) {
      this.starting = (async () => {
        const base = redisManager.getClient();
        if (!base) throw new Error("Redis unavailable");
        const subscriber = base.duplicate();
        subscriber.on("message", (_channel: string, raw: string) => this.dispatch(raw));
        await subscriber.subscribe(CHANNEL);
        this.subscriber = subscriber;
        setInterval(() => this.sweep(), HEARTBEAT_MS).unref();
        logger.info("MESSAGES: subscribed to realtime channel");
      })().catch((error) => {
        this.starting = null;
        throw error;
      });
    }
    return this.starting;
  }

  add(client: TClient): boolean {
    const set = this.clients.get(client.userId) ?? new Set<TClient>();
    if (set.size >= MAX_SOCKETS_PER_USER) return false;
    set.add(client);
    this.clients.set(client.userId, set);
    return true;
  }

  remove(client: TClient) {
    const set = this.clients.get(client.userId);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) this.clients.delete(client.userId);
  }

  private dispatch(raw: string) {
    let parsed: { member_ids?: unknown; event?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(parsed.member_ids) || typeof parsed.event !== "object" || parsed.event === null) return;
    const frame = JSON.stringify(parsed.event);
    for (const memberId of parsed.member_ids) {
      if (typeof memberId !== "string") continue;
      for (const client of this.clients.get(memberId) ?? []) {
        if (client.ws.readyState === client.ws.OPEN) client.ws.send(frame);
      }
    }
  }

  private sweep() {
    const now = Date.now();
    for (const set of this.clients.values()) {
      for (const client of set) {
        if (!client.alive) {
          client.ws.terminate();
          continue;
        }
        client.alive = false;
        client.ws.ping();
        if (now - client.validatedAt > REVALIDATE_MS) {
          client.validatedAt = now;
          void currentUserId(client.cookie).then((id) => {
            if (id !== client.userId) client.ws.close(4401, "Session expired");
          });
        }
      }
    }
  }
}

const hub = new MessagingHub();

async function currentUserId(cookie: string): Promise<string | null> {
  try {
    const user = await new UserService().currentUser(cookie);
    return user?.id ?? null;
  } catch {
    return null;
  }
}

function isAllowedOrigin(origin: string | undefined): boolean {
  const allowed = env.CORS_ALLOWED_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return true; // same behaviour as the HTTP CORS config
  return !!origin && allowed.includes(origin);
}

@Controller("/messages")
export class MessagesController {
  [key: string]: unknown;

  @WSDecorator("/")
  async handleConnection(ws: WebSocket, req: Request) {
    try {
      if (!isAllowedOrigin(req.headers.origin)) {
        ws.close(4403, "Origin not allowed");
        return;
      }
      const cookie = req.headers.cookie?.toString() ?? "";
      if (!cookie) {
        ws.close(4401, "Unauthorized");
        return;
      }
      await hub.start();
      const userId = await currentUserId(cookie);
      if (!userId || ws.readyState !== ws.OPEN) {
        ws.close(4401, "Unauthorized");
        return;
      }
      const client: TClient = { ws, userId, cookie, alive: true, validatedAt: Date.now() };
      if (!hub.add(client)) {
        ws.close(4429, "Too many connections");
        return;
      }
      ws.on("pong", () => {
        client.alive = true;
      });
      // Push-only channel: clients have nothing to say; drop anyone who floods it.
      ws.on("message", (data: Buffer) => {
        if (data.length > MAX_CLIENT_FRAME_BYTES) ws.close(1009, "Frame too large");
      });
      ws.on("close", () => hub.remove(client));
      ws.on("error", (error: Error) => {
        logger.error("MESSAGES: WebSocket error", error);
        hub.remove(client);
      });
      ws.send(JSON.stringify({ type: "ready" }));
    } catch (error) {
      logger.error("MESSAGES: connection setup failed", error);
      ws.close(1011, "Internal server error");
    }
  }
}
