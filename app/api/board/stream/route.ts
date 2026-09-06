import { MAX_BRIEF_CHARS } from "@/lib/board-constants";
import type { BoardEmitEvent, BoardStreamEvent, StreamAction } from "@/lib/board-events";
import {
  resumeBoardSessionWithEvents,
  runBoardSessionWithEvents,
} from "@/lib/board-runner";
import type { StreamContext } from "@/lib/board-events";

export const maxDuration = 300;

type RequestBody = {
  sessionId?: string;
  brief?: string;
  action?: StreamAction["action"];
  message?: string;
  scheduleIndex?: number;
  invitedRoleIds?: string[];
};

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const parsed = body as RequestBody;
  const action = parsed.action ?? "start";
  const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
  const scheduleIndex =
    typeof parsed.scheduleIndex === "number" ? parsed.scheduleIndex : 0;
  const invitedRoleIds = Array.isArray(parsed.invitedRoleIds)
    ? parsed.invitedRoleIds.filter((id): id is string => typeof id === "string")
    : [];

  let userBrief = typeof parsed.brief === "string" ? parsed.brief.trim() : "";

  if (action === "start") {
    if (!userBrief) {
      return new Response(JSON.stringify({ error: "brief must be non-empty" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (userBrief.length > MAX_BRIEF_CHARS) {
      return new Response(
        JSON.stringify({ error: `brief exceeds ${MAX_BRIEF_CHARS} characters` }),
        { status: 413, headers: { "Content-Type": "application/json" } },
      );
    }
  } else {
    if (!message && action !== "approve_proposal") {
      return new Response(JSON.stringify({ error: "message is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const streamContext: StreamContext | undefined =
    action !== "start"
      ? parseStreamContext(body)
      : undefined;

if (
  !message &&
  action !== "approve_proposal" &&
  action !== "resume_interrupted"
) {
  return new Response(JSON.stringify({ error: "message is required" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

  if (streamContext) {
    userBrief = streamContext.userBrief;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (obj: BoardStreamEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      };
      try {
        if (action === "start") {
          await runBoardSessionWithEvents(
            userBrief,
            async (event: BoardEmitEvent) => {
              write(event);
            },
            undefined,
            req.signal,
          );
        } else {
            const streamAction: StreamAction =
              action === "approve_proposal"
                ? { action: "approve_proposal", invitedRoleIds }
                : action === "brief_reply"
                  ? { action: "brief_reply", message }
                  : action === "proposal_reply"
                    ? { action: "proposal_reply", message }
                    : action === "interrupt_discussion"
                      ? { action: "interrupt_discussion", message, scheduleIndex }
                      : action === "resume_interrupted"
                        ? { action: "resume_interrupted", scheduleIndex }
                        : { action: "follow_up", message };

          await resumeBoardSessionWithEvents(
            streamAction,
            streamContext!,
            async (event: BoardEmitEvent) => {
              write(event);
            },
            req.signal,
          );
        }
        write({ type: "done" });
      } catch (e) {
        const errMessage = e instanceof Error ? e.message : "Unknown error";
        write({ type: "error", message: errMessage });
        write({ type: "done" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function parseStreamContext(body: unknown): StreamContext | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const o = body as Record<string, unknown>;
  if (typeof o.userBrief !== "string" || !o.userBrief.trim()) return undefined;
  return {
    userBrief: o.userBrief.trim(),
    meetingPlan: (o.meetingPlan as StreamContext["meetingPlan"]) ?? null,
    turns: Array.isArray(o.turns) ? (o.turns as StreamContext["turns"]) : [],
    briefing: (o.briefing as StreamContext["briefing"]) ?? null,
    glossary: (o.glossary as StreamContext["glossary"]) ?? null,
    roundCount: typeof o.roundCount === "number" ? o.roundCount : 0,
    pendingProposal:
      (o.pendingProposal as StreamContext["pendingProposal"]) ?? null,
    userMessages: Array.isArray(o.userMessages)
      ? (o.userMessages as StreamContext["userMessages"])
      : [],
  };
}
