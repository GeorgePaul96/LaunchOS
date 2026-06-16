import { z } from "zod";
import type { LaunchOSClient } from "@/lib/sdk/client";
import type { AttributionModel } from "@/lib/sdk/types";

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  run: (client: LaunchOSClient, args: Record<string, unknown>) => Promise<unknown>;
}

export const tools: ToolDef[] = [
  { name: "list_accounts", description: "List connected social accounts.", schema: {},
    run: (c) => c.accounts.list() },
  { name: "list_posts", description: "List posts and their target statuses.", schema: {},
    run: (c) => c.posts.list() },
  { name: "create_post", description: "Create and queue a post to one or more accounts.",
    schema: { profileId: z.string(), content: z.string(), accountIds: z.array(z.string()) },
    run: (c, a) => c.posts.create({ profileId: a.profileId as string, content: a.content as string, accountIds: a.accountIds as string[] }) },
  { name: "attribution_report", description: "Channel revenue attribution for a model (first_touch | last_touch | linear).",
    schema: { model: z.enum(["first_touch", "last_touch", "linear"]) },
    run: (c, a) => c.attribution.report(a.model as AttributionModel) },
  { name: "contact_journey", description: "Chronological touchpoint+conversion timeline for a contact id.",
    schema: { contactId: z.string() },
    run: (c, a) => c.journeys.timeline(a.contactId as string) },
  { name: "record_touchpoint", description: "Record a marketing touchpoint against an identity.",
    schema: { identityId: z.string(), channel: z.string(), platform: z.string().optional(), sourceId: z.string().optional() },
    run: (c, a) => c.attribution.touchpoint({ identityId: a.identityId as string, channel: a.channel as string, platform: a.platform as string | undefined, sourceId: a.sourceId as string | undefined }) },
  { name: "record_conversion", description: "Record a conversion/revenue event against an identity.",
    schema: { identityId: z.string(), eventName: z.string(), valueCents: z.number().optional() },
    run: (c, a) => c.attribution.conversion({ identityId: a.identityId as string, eventName: a.eventName as string, valueCents: a.valueCents as number | undefined }) },
];
