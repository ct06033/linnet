/**
 * linnet.commands — first-party slash commands through the registry seam.
 * ctx payload: { client, roomId, setDraft } (Composer.run's `ctx` argument).
 */
import { EventType, type MatrixClient } from "matrix-js-sdk";
import type { LinnetModule } from "@linnet/core";

export interface CommandCtx {
  client: MatrixClient;
  roomId: string;
  setDraft?: (text: string) => void;
}

export const coreCommandsModule: LinnetModule = {
  id: "linnet.commands",
  contributions: () => [
    {
      slot: "slash-command" as const,
      command: "/me",
      description: "Send as an emote (* action)",
      run: async (args: string, rawCtx: unknown) => {
        const ctx = rawCtx as CommandCtx;
        await ctx.client.sendEvent(ctx.roomId, EventType.RoomMessage, {
          msgtype: "m.emote",
          body: args,
        } as never);
      },
    },
    {
      slot: "slash-command" as const,
      command: "/join",
      description: "Join a room by id or alias",
      run: async (args: string, rawCtx: unknown) => {
        const ctx = rawCtx as CommandCtx;
        const target = args.trim().replace(/^#/, "#");
        if (target) await ctx.client.joinRoom(target);
      },
    },
    {
      slot: "slash-command" as const,
      command: "/part",
      description: "Leave the current room",
      run: async (_args: string, rawCtx: unknown) => {
        const ctx = rawCtx as CommandCtx;
        await ctx.client.leave(ctx.roomId);
      },
    },
    {
      slot: "slash-command" as const,
      command: "/invite",
      description: "Invite a user: /invite @user:hs",
      run: async (args: string, rawCtx: unknown) => {
        const ctx = rawCtx as CommandCtx;
        const userId = args.trim().split(/\s+/)[0] ?? "";
        if (userId.startsWith("@")) await ctx.client.invite(ctx.roomId, userId);
      },
    },
    {
      slot: "slash-command" as const,
      command: "/topic",
      description: "Set the room topic",
      run: async (args: string, rawCtx: unknown) => {
        const ctx = rawCtx as CommandCtx;
        await ctx.client.sendStateEvent(ctx.roomId, EventType.RoomTopic, { topic: args } as never, "");
      },
    },
    {
      slot: "slash-command" as const,
      command: "/nick",
      description: "Set your display name",
      run: async (args: string, rawCtx: unknown) => {
        const ctx = rawCtx as CommandCtx;
        await ctx.client.setDisplayName(args.trim());
      },
    },
    {
      slot: "slash-command" as const,
      command: "/shrug",
      description: "Shrug ( ͡° ͜ʖ ͡°)",
      run: async (args: string, rawCtx: unknown) => {
        const ctx = rawCtx as CommandCtx;
        await ctx.client.sendEvent(ctx.roomId, EventType.RoomMessage, {
          msgtype: "m.text",
          body: `¯\\_(ツ)_/¯ ${args}`.trim(),
        } as never);
      },
    },
    {
      slot: "slash-command" as const,
      command: "/spoil",
      description: "Send the text hidden behind a spoiler",
      run: async (args: string, rawCtx: unknown) => {
        const ctx = rawCtx as CommandCtx;
        await ctx.client.sendEvent(ctx.roomId, EventType.RoomMessage, {
          msgtype: "m.text",
          body: `||${args}||`,
          format: "org.matrix.custom.html",
          formatted_body: `<details class="mx-spoiler"><summary>Spoiler</summary>${args.replace(/</g, "&lt;")}</details>`,
        } as never);
      },
    },
  ],
};
