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
const MAX_PENDING_PER_IP = 20;
// Presence (sidebar "Membros"): one Redis key per connected user. The API decides who may read it.
const PRESENCE_TTL_S = 90; // refreshed every heartbeat, so a crashed server clears itself
const OFFLINE_GRACE_MS = 10_000; // a page reload must not flicker the dot
const presenceKey = (userId: string) => `labi:presence:${userId}`;

// Connections still authenticating, per client IP (each one costs an API call).
const pendingByIp = new Map<string, number>();

/** Rightmost X-Forwarded-For hop is appended by our own proxy chain; leftmost entries are client-controlled. */
function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const hops = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? ""))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return hops[hops.length - 1] || req.socket.remoteAddress || "unknown";
}

type TClient = { ws: WebSocket; userId: string; cookie: string; alive: boolean; validatedAt: number };

class MessagingHub {
  private readonly clients = new Map<string, Set<TClient>>();
  private readonly offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
    const pendingOffline = this.offlineTimers.get(client.userId);
    if (pendingOffline) {
      clearTimeout(pendingOffline);
      this.offlineTimers.delete(client.userId);
    } else if (set.size === 0) {
      void this.setPresence(client.userId, true);
    }
    set.add(client);
    this.clients.set(client.userId, set);
    return true;
  }

  remove(client: TClient) {
    const set = this.clients.get(client.userId);
    if (!set) return;
    set.delete(client);
    if (set.size > 0) return;
    this.clients.delete(client.userId);
    this.offlineTimers.set(
      client.userId,
      setTimeout(() => {
        this.offlineTimers.delete(client.userId);
        if (!this.clients.has(client.userId)) void this.setPresence(client.userId, false);
      }, OFFLINE_GRACE_MS)
    );
  }

  private async setPresence(userId: string, online: boolean) {
    const redis = redisManager.getClient();
    try {
      if (online) await redis?.set(presenceKey(userId), "1", "EX", PRESENCE_TTL_S);
      else await redis?.del(presenceKey(userId));
    } catch (error) {
      logger.error("MESSAGES: presence update failed", error);
    }
    // Carries no identity: each client asks the API, which applies the workspace permissions.
    const frame = JSON.stringify({ type: "presence.changed" });
    for (const set of this.clients.values()) {
      for (const client of set) {
        if (client.ws.readyState === client.ws.OPEN) client.ws.send(frame);
      }
    }
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
    const redis = redisManager.getClient();
    for (const [userId, set] of this.clients) {
      redis?.set(presenceKey(userId), "1", "EX", PRESENCE_TTL_S).catch(() => undefined);
      for (const client of set) {
        if (!client.alive) {
          client.ws.terminate();
          continue;
        }
        client.alive = false;
        client.ws.ping();
        if (now - client.validatedAt > REVALIDATE_MS) {
          client.validatedAt = now;
          void revalidate(client);
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

/** 401/403 from the API = session gone (4401, client stops). Other failures = transient (1012, client reconnects). */
async function revalidate(client: TClient): Promise<void> {
  try {
    const user = await new UserService().currentUser(client.cookie);
    if (user?.id !== client.userId) client.ws.close(4401, "Session expired");
  } catch (error) {
    const status = (error as { statusCode?: number })?.statusCode; // AppError keeps the HTTP status
    if (status === 401 || status === 403) client.ws.close(4401, "Session expired");
    else client.ws.close(1012, "Service restart");
  }
}

/** Fail closed: configured origins, or (when none are configured) only the host serving this request. */
function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  const allowed = env.CORS_ALLOWED_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length > 0) return allowed.includes(origin);
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? req.headers.host;
  try {
    return !!host && new URL(origin).host === host.split(",")[0].trim();
  } catch {
    return false;
  }
}

@Controller("/messages")
export class MessagesController {
  [key: string]: unknown;

  @WSDecorator("/")
  async handleConnection(ws: WebSocket, req: Request) {
    try {
      if (!isAllowedOrigin(req)) {
        ws.close(4403, "Origin not allowed");
        return;
      }
      const cookie = req.headers.cookie?.toString() ?? "";
      if (!cookie) {
        ws.close(4401, "Unauthorized");
        return;
      }
      const ip = clientIp(req);
      const pending = pendingByIp.get(ip) ?? 0;
      if (pending >= MAX_PENDING_PER_IP) {
        ws.close(4429, "Too many pending connections");
        return;
      }
      pendingByIp.set(ip, pending + 1);
      let userId: string | null;
      try {
        await hub.start();
        userId = await currentUserId(cookie);
      } finally {
        const left = (pendingByIp.get(ip) ?? 1) - 1;
        if (left <= 0) pendingByIp.delete(ip);
        else pendingByIp.set(ip, left);
      }
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
