import type { AgentOptions } from "@cursor/sdk";

import type { BoardEmitEvent, StreamAction, StreamContext } from "./board-events";
import { MAX_TURNS, MIN_ROLES } from "./board-constants";
import { runPromptForText, runPromptStreaming, getAgentOptions } from "./agent-client";
import { extractJsonObject } from "./json-extract";
import { generateGlossary, generateGlossaryIncremental } from "./glossary-agent";
import { mergeGlossaries } from "./glossary-merge";
import {
  chairBriefingPrompt,
  chairBriefingRetryPrompt,
  chairMeetingPlanPrompt,
  chairMeetingPlanRetryPrompt,
  chairProposalRevisionPrompt,
  chairReplyPrompt,
  chairRouterPrompt,
  expertDirectReplyPrompt,
  expertTurnPrompt,
} from "./prompts";
import type {
  ChairBriefing,
  ChairRoute,
  Glossary,
  MeetingPlan,
  MeetingProposal,
  TranscriptTurn,
} from "./schemas";
import {
  briefingSchema,
  chairBriefClarificationSchema,
  chairRouteSchema,
  meetingPlanSchema,
  meetingProposalSchema,
} from "./schemas";

export type { BoardRunResult } from "./board-events";
export { getAgentOptions } from "./agent-client";

export async function runBoardSessionWithEvents(
  userBrief: string,
  sink: (event: BoardEmitEvent) => void | Promise<void>,
  ctx?: Partial<StreamContext>,
  abortSignal?: AbortSignal,
): Promise<void> {
  const options = getAgentOptions();

  if (ctx?.pendingProposal && !ctx.meetingPlan) {
    await runDiscussionFromPlan(
      userBrief,
      proposalToPlan(ctx.pendingProposal),
      ctx.turns ?? [],
      (ctx.roundCount ?? 0) + 1,
      sink,
      options,
      { includeGlossary: true, abortSignal },
    );
    return;
  }

  const kickoff = await generateChairKickoff(userBrief, options);
  if (kickoff.type === "clarification") {
    await sink({
      type: "chair_message",
      payload: {
        id: crypto.randomUUID(),
        content: kickoff.chairMessage,
        roundId: 0,
      },
    });
    await sink({ type: "awaiting_brief" });
    return;
  }

  const proposal = kickoff.proposal;
  await sink({ type: "meeting_proposal", payload: proposal });
  const reason =
    proposal.goalNeedsConfirmation && proposal.rosterNeedsConfirmation
      ? "both"
      : proposal.goalNeedsConfirmation
        ? "goal"
        : "roster";
  await sink({ type: "awaiting_user", reason });
}

export async function resumeBoardSessionWithEvents(
  action: StreamAction,
  ctx: StreamContext,
  sink: (event: BoardEmitEvent) => void | Promise<void>,
  abortSignal?: AbortSignal,
): Promise<void> {
  const options = getAgentOptions();

  if (action.action === "brief_reply") {
    await runBoardSessionWithEvents(ctx.userBrief.trim(), sink, undefined, abortSignal);
    return;
  }

  if (action.action === "approve_proposal" && ctx.pendingProposal) {
    const plan = planFromProposalWithInvites(ctx.pendingProposal, action.invitedRoleIds);
    await sink({ type: "meeting_plan", payload: plan, roundId: (ctx.roundCount || 0) + 1 });
    await runDiscussionFromPlan(
      ctx.userBrief,
      plan,
      ctx.turns,
      (ctx.roundCount || 0) + 1,
      sink,
      options,
      { includeGlossary: true, abortSignal },
    );
    return;
  }

  if (action.action === "proposal_reply" && ctx.pendingProposal) {
    const revised = await reviseMeetingProposal(
      ctx.userBrief,
      ctx.pendingProposal,
      action.message,
      options,
    );
    await sink({ type: "meeting_proposal", payload: revised });
    const reason =
      revised.goalNeedsConfirmation && revised.rosterNeedsConfirmation
        ? "both"
        : revised.goalNeedsConfirmation
          ? "goal"
          : "roster";
    await sink({ type: "awaiting_user", reason });
    return;
  }

  if (action.action === "follow_up" && ctx.meetingPlan) {
    await runFollowUp(ctx.userBrief, action.message, ctx, sink, options);
    return;
  }

  if (action.action === "interrupt_discussion" && ctx.meetingPlan) {
    await runDiscussionFromPlan(
      ctx.userBrief,
      ctx.meetingPlan,
      ctx.turns,
      ctx.roundCount || 1,
      sink,
      options,
      {
        includeGlossary: true,
        includeBriefing: true,
        scheduleIndex: action.scheduleIndex,
        userInterjection: action.message,
        userMessages: ctx.userMessages,
        existingGlossary: ctx.glossary,
        abortSignal,
      },
    );
    return;
  }

  if (action.action === "resume_interrupted" && ctx.meetingPlan) {
    await runDiscussionFromPlan(
      ctx.userBrief,
      ctx.meetingPlan,
      ctx.turns,
      ctx.roundCount || 1,
      sink,
      options,
      {
        includeGlossary: true,
        includeBriefing: true,
        scheduleIndex: action.scheduleIndex,
        userMessages: ctx.userMessages,
        existingGlossary: ctx.glossary,
        abortSignal,
      },
    );
    return;
  }




  
  throw new Error("Invalid resume action or missing session context");
}

async function runFollowUp(
  userBrief: string,
  message: string,
  ctx: StreamContext,
  sink: (event: BoardEmitEvent) => void | Promise<void>,
  options: AgentOptions,
): Promise<void> {
  const plan = ctx.meetingPlan!;
  const transcriptText = formatTranscriptForPrompt(ctx.turns, {
    userBrief,
    userMessages: ctx.userMessages,
  });
  const briefingSummary = ctx.briefing
    ? `${ctx.briefing.headline}\n${ctx.briefing.thesis}`
    : undefined;

  const route = await routeFollowUp(
    message,
    plan,
    transcriptText,
    briefingSummary,
    options,
  );

  const roundId = (ctx.roundCount || 1) + 1;
  const userMessages = ctx.userMessages ?? [];

  switch (route.action) {
    case "expert_direct": {
      const roleId = route.targetRoleId;
      const role = plan.roles.find((r) => r.id === roleId);
      if (!role) {
        await sink({
          type: "chair_message",
          payload: {
            id: crypto.randomUUID(),
            content:
              "I couldn't tell which expert you meant — try @mentioning them by title.",
            roundId,
          },
        });
        return;
      }
      const prompt = expertDirectReplyPrompt({
        expertTitle: role.title,
        mandate: role.mandate,
        transcriptLines: formatTranscriptForPrompt(ctx.turns, {
          userBrief,
          userMessages,
        }),
        userMessage: message,
        briefingSummary,
      });
      const maxId = ctx.turns.reduce((m, t) => Math.max(m, t.id), 0);
      const turnId = maxId + 1;
      await sink({
        type: "turn_start",
        payload: { id: turnId, roleId: role.id, roleName: role.title },
        roundId,
      });
      const { text } = await runPromptStreaming(
        prompt,
        options,
        async (delta) => {
          await sink({ type: "turn_delta", payload: { id: turnId, delta }, roundId });
        },
      );
      const turn: TranscriptTurn = {
        id: turnId,
        roleId: role.id,
        roleName: role.title,
        content: text,
      };
      await sink({ type: "turn", payload: turn, roundId });
      return;
    }

    case "chair_reply": {
      const chairId = crypto.randomUUID();
      await sink({
        type: "chair_start",
        payload: { id: chairId, roundId },
      });
      const reply =
        route.chairReply?.trim() ??
        (
          await runPromptStreaming(
            chairReplyPrompt({
              userMessage: message,
              transcriptText,
              meetingGoal: plan.meetingGoal,
              briefingSummary,
            }),
            options,
            async (delta) => {
              await sink({
                type: "chair_delta",
                payload: { id: chairId, delta, roundId },
              });
            },
          )
        ).text;
      await sink({
        type: "chair_message",
        payload: { id: chairId, content: reply.trim(), roundId },
      });
      return;
    }

    case "revise_roster": {
      const newRoles = route.newRoles ?? [];
      const updatedPlan: MeetingPlan = {
        ...plan,
        roles: [...plan.roles, ...newRoles.filter((nr) => !plan.roles.some((r) => r.id === nr.id))],
        meetingGoal: route.followUpGoal ?? plan.meetingGoal,
        turnSchedule:
          route.turnSchedule && route.turnSchedule.length > 0
            ? route.turnSchedule
            : plan.turnSchedule,
      };
      const finalized = finalizeMeetingPlan(updatedPlan);
      await sink({ type: "meeting_plan", payload: finalized, roundId });
      await runDiscussionFromPlan(
        userBrief,
        finalized,
        ctx.turns,
        roundId,
        sink,
        options,
        {
          includeGlossary: true,
          includeBriefing: true,
          userMessages,
          userInterjection: message,
        },
      );
      return;
    }

    case "follow_up_round": {
      const schedule =
        route.turnSchedule && route.turnSchedule.length > 0
          ? route.turnSchedule
          : plan.turnSchedule;
      const roundPlan: MeetingPlan = {
        ...plan,
        meetingGoal: route.followUpGoal ?? plan.meetingGoal,
        turnSchedule: schedule,
      };
      const finalized = finalizeMeetingPlan(roundPlan);
      await sink({ type: "meeting_plan", payload: finalized, roundId });
      await runDiscussionFromPlan(
        userBrief,
        finalized,
        ctx.turns,
        roundId,
        sink,
        options,
        {
          includeGlossary: true,
          includeBriefing: true,
          userMessages,
          userInterjection: message,
        },
      );
      return;
    }

    default:
      throw new Error(`Unknown route action: ${(route as ChairRoute).action}`);
  }
}

async function runDiscussionFromPlan(
  userBrief: string,
  plan: MeetingPlan,
  priorTurns: TranscriptTurn[],
  roundId: number,
  sink: (event: BoardEmitEvent) => void | Promise<void>,
  options: AgentOptions,
  flags: {
    includeBriefing?: boolean;
    includeGlossary?: boolean;
    scheduleIndex?: number;
    userInterjection?: string;
    userMessages?: StreamContext["userMessages"];
    abortSignal?: AbortSignal;
    existingGlossary?: Glossary | null;
  } = {},
): Promise<void> {
  const turns: TranscriptTurn[] = [...priorTurns];
  const scheduleStart = flags.scheduleIndex ?? 0;
  const otherTitles = () => plan.roles.map((r) => ({ title: r.title }));
  let accumulatedGlossary: Glossary = flags.existingGlossary ?? { entries: [] };
  const ownerInterjection = flags.userInterjection?.trim() || undefined;
  const userMessages = flags.userMessages ?? [];
  let pendingGlossary: Promise<Glossary> | null = null;

  const maxTurnId = turns.reduce((m, t) => Math.max(m, t.id), 0);
  let nextTurnId = maxTurnId;

  for (let i = scheduleStart; i < plan.turnSchedule.length; i++) {
    if (flags.abortSignal?.aborted) {
      return;
    }

    if (pendingGlossary) {
      const incremental = await pendingGlossary;
      accumulatedGlossary = mergeGlossaries(accumulatedGlossary, incremental);
      if (incremental.entries.length > 0) {
        await sink({ type: "glossary", payload: accumulatedGlossary, roundId });
      }
      pendingGlossary = null;
    }

    const roleId = plan.turnSchedule[i]!;
    const role = plan.roles.find((r) => r.id === roleId);
    if (!role) {
      throw new Error(`Internal error: missing role ${roleId}`);
    }

    const transcriptForPrompt = formatTranscriptForPrompt(turns, {
      userBrief,
      userMessages,
      ownerInterjection,
    });

    const prompt = expertTurnPrompt({
      expertTitle: role.title,
      mandate: role.mandate,
      otherExperts: otherTitles().filter((o) => o.title !== role.title),
      transcriptLines: transcriptForPrompt,
      chairNotes: plan.chairNotesForFacilitator,
      userQuestion: ownerInterjection,
      roundGoal: plan.meetingGoal,
    });

    if (flags.abortSignal?.aborted) {
      return;
    }

    nextTurnId += 1;
    const turnId = nextTurnId;
    await sink({
      type: "turn_start",
      payload: { id: turnId, roleId: role.id, roleName: role.title },
      roundId,
    });

    const { text, runId } = await runPromptStreaming(
      prompt,
      options,
      async (delta) => {
        await sink({ type: "turn_delta", payload: { id: turnId, delta }, roundId });
      },
      flags.abortSignal,
    );
    console.info(
      "[board] expert turn",
      i + 1,
      "/",
      plan.turnSchedule.length,
      runId,
      role.id,
      "round",
      roundId,
    );

    const turn: TranscriptTurn = {
      id: turnId,
      roleId: role.id,
      roleName: role.title,
      content: text,
    };
    turns.push(turn);
    await sink({ type: "turn", payload: turn, roundId });

    if (flags.includeGlossary) {
      pendingGlossary = generateGlossaryIncremental(userBrief, plan, turns, options);
    }
  }

  if (pendingGlossary) {
    const incremental = await pendingGlossary;
    accumulatedGlossary = mergeGlossaries(accumulatedGlossary, incremental);
    if (incremental.entries.length > 0) {
      await sink({ type: "glossary", payload: accumulatedGlossary, roundId });
    }
  }

  if (flags.abortSignal?.aborted) {
    return;
  }

  const roundTurns = turns.slice(priorTurns.length);
  let briefing: ChairBriefing | null = null;

  if (flags.includeBriefing !== false && roundTurns.length > 0) {
    briefing = await generateBriefing(
      userBrief,
      plan,
      turns,
      options,
      roundId > 1 ? `follow-up round ${roundId}` : undefined,
      userMessages,
    );
    await sink({ type: "briefing", payload: briefing, roundId });
  }

  if (flags.includeGlossary && briefing) {
    const finalGlossary = await generateGlossary(
      userBrief,
      plan,
      turns,
      briefing,
      options,
    );
    accumulatedGlossary = mergeGlossaries(accumulatedGlossary, finalGlossary);
    await sink({ type: "glossary", payload: accumulatedGlossary, roundId });
  }
}

function proposalToPlan(proposal: MeetingProposal): MeetingPlan {
  const {
    goalNeedsConfirmation: _goalNeedsConfirmation,
    rosterNeedsConfirmation: _rosterNeedsConfirmation,
    chairMessage: _chairMessage,
    id: _proposalId,
    ...plan
  } = proposal;
  void _goalNeedsConfirmation;
  void _rosterNeedsConfirmation;
  void _chairMessage;
  void _proposalId;
  return finalizeMeetingPlan(plan);
}

function planFromProposalWithInvites(
  proposal: MeetingProposal,
  invitedRoleIds: string[],
): MeetingPlan {
  if (invitedRoleIds.length < MIN_ROLES) {
    throw new Error(`Invite at least ${MIN_ROLES} experts to start the meeting`);
  }
  const invited = new Set(invitedRoleIds);
  const roles = proposal.roles.filter((r) => invited.has(r.id));
  if (roles.length !== invitedRoleIds.length) {
    throw new Error("One or more invited experts are not in the proposal");
  }
  const turnSchedule = proposal.turnSchedule.filter((id) => invited.has(id));
  const {
    goalNeedsConfirmation: _g,
    rosterNeedsConfirmation: _r,
    chairMessage: _c,
    id: _id,
    ...rest
  } = proposal;
  void _g;
  void _r;
  void _c;
  void _id;
  return finalizeMeetingPlan({
    ...rest,
    roles,
    turnSchedule,
  });
}

export async function runBoardSession(userBrief: string) {
  const turns: TranscriptTurn[] = [];
  let meetingPlan: MeetingPlan | undefined;
  let briefing: ChairBriefing | undefined;
  let glossary: Glossary | undefined;

  await runBoardSessionWithEvents(userBrief, async (e) => {
    switch (e.type) {
      case "meeting_plan":
        meetingPlan = e.payload;
        break;
      case "turn":
        turns.push(e.payload);
        break;
      case "briefing":
        briefing = e.payload;
        break;
      case "glossary":
        glossary = e.payload;
        break;
    }
  });

  if (!meetingPlan || !briefing || glossary === undefined) {
    throw new Error("Incomplete board session aggregation");
  }

  return {
    meetingPlan,
    transcript: { turns },
    briefing,
    glossary,
  };
}

function parseMeetingPlanJson(raw: string): MeetingPlan {
  const jsonStr = extractJsonObject(raw);
  const data: unknown = JSON.parse(jsonStr);
  return meetingPlanSchema.parse(data);
}

function parseChairKickoffJson(
  raw: string,
  id?: string,
):
  | { type: "clarification"; chairMessage: string }
  | { type: "proposal"; proposal: MeetingProposal } {
  const jsonStr = extractJsonObject(raw);
  const data: unknown = JSON.parse(jsonStr);
  if (
    typeof data === "object" &&
    data !== null &&
    (data as { briefSufficient?: boolean }).briefSufficient === false
  ) {
    const clarification = chairBriefClarificationSchema.parse(data);
    return { type: "clarification", chairMessage: clarification.chairMessage };
  }
  return { type: "proposal", proposal: parseMeetingProposalJson(raw, id) };
}

function parseMeetingProposalJson(raw: string, id?: string): MeetingProposal {
  const jsonStr = extractJsonObject(raw);
  const data: unknown = JSON.parse(jsonStr);
  const parsed = meetingProposalSchema.parse({
    ...(typeof data === "object" && data !== null ? data : {}),
    id: id ?? crypto.randomUUID(),
  });
  return {
    ...parsed,
    ...finalizeMeetingPlan(parsed),
  };
}

function parseBriefingJson(raw: string): ChairBriefing {
  const jsonStr = extractJsonObject(raw);
  const data: unknown = JSON.parse(jsonStr);
  return briefingSchema.parse(data);
}

function parseChairRouteJson(raw: string): ChairRoute {
  const jsonStr = extractJsonObject(raw);
  const data: unknown = JSON.parse(jsonStr);
  return chairRouteSchema.parse(data);
}

/** Ensure schedule references only known roles; one turn per role. */
export function finalizeMeetingPlan(plan: MeetingPlan): MeetingPlan {
  const ids = new Set(plan.roles.map((r) => r.id));
  const bad = plan.turnSchedule.find((id) => !ids.has(id));
  if (bad) {
    throw new Error(`turnSchedule references unknown roleId: ${bad}`);
  }

  const roleIds = plan.roles.map((r) => r.id);
  const seen = new Set<string>();
  const schedule: string[] = [];

  for (const id of plan.turnSchedule) {
    if (ids.has(id) && !seen.has(id)) {
      schedule.push(id);
      seen.add(id);
    }
  }
  for (const id of roleIds) {
    if (!seen.has(id)) {
      schedule.push(id);
      seen.add(id);
    }
  }

  return { ...plan, turnSchedule: schedule.slice(0, MAX_TURNS) };
}

export type UserMessageLine = {
  content: string;
  timestamp?: number;
  roundId?: number;
};

function formatTranscriptForPrompt(
  turns: TranscriptTurn[],
  options?: {
    userBrief?: string;
    userMessages?: UserMessageLine[];
    ownerInterjection?: string;
  },
): string {
  const parts: string[] = [];

  if (options?.userBrief?.trim()) {
    parts.push(
      `Owner's brief (what this session must address):\n---\n${options.userBrief.trim()}\n---`,
    );
  }

  const priorUserMessages =
    options?.userMessages?.filter(
      (m) => !options.ownerInterjection || m.content.trim() !== options.ownerInterjection.trim(),
    ) ?? [];
  for (const msg of priorUserMessages) {
    parts.push(`Owner: ${msg.content.trim()}`);
  }

  if (turns.length > 0) {
    parts.push(turns.map((t) => `${t.roleName}: ${t.content}`).join("\n\n"));
  }

  if (options?.ownerInterjection?.trim()) {
    parts.push(`Owner: ${options.ownerInterjection.trim()}`);
  }

  if (parts.length === 0) {
    return "(Meeting just started — no prior lines.)";
  }

  return parts.join("\n\n");
}

async function generateChairKickoff(
  userBrief: string,
  options: AgentOptions,
):
  Promise<
    | { type: "clarification"; chairMessage: string }
    | { type: "proposal"; proposal: MeetingProposal }
  > {
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? chairMeetingPlanPrompt(userBrief)
        : chairMeetingPlanRetryPrompt(userBrief, lastErr);
    const { text, runId } = await runPromptForText(prompt, options);
    console.info("[board] chair kickoff run", runId);
    try {
      return parseChairKickoffJson(text);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (attempt === 1) {
        throw new Error(`Invalid chair kickoff JSON: ${lastErr}`);
      }
    }
  }
  throw new Error("Unreachable");
}

async function generateMeetingProposal(
  userBrief: string,
  options: AgentOptions,
): Promise<MeetingProposal> {
  const kickoff = await generateChairKickoff(userBrief, options);
  if (kickoff.type === "clarification") {
    throw new Error("Brief insufficient for meeting proposal");
  }
  return kickoff.proposal;
}

async function reviseMeetingProposal(
  userBrief: string,
  current: MeetingProposal,
  userReply: string,
  options: AgentOptions,
): Promise<MeetingProposal> {
  const prompt = chairProposalRevisionPrompt({
    userBrief,
    currentProposalJson: JSON.stringify(current),
    userReply,
  });
  const { text, runId } = await runPromptForText(prompt, options);
  console.info("[board] proposal revision run", runId);
  return parseMeetingProposalJson(text, current.id);
}

async function routeFollowUp(
  message: string,
  plan: MeetingPlan,
  transcriptText: string,
  briefingSummary: string | undefined,
  options: AgentOptions,
): Promise<ChairRoute> {
  const prompt = chairRouterPrompt({
    userMessage: message,
    meetingPlanJson: JSON.stringify(plan),
    transcriptText,
    briefingSummary,
  });
  const { text } = await runPromptForText(prompt, options);
  return parseChairRouteJson(text);
}

async function generateBriefing(
  userBrief: string,
  plan: MeetingPlan,
  turns: TranscriptTurn[],
  options: AgentOptions,
  roundLabel?: string,
  userMessages?: UserMessageLine[],
): Promise<ChairBriefing> {
  const transcriptText = formatTranscriptForPrompt(turns, {
    userBrief,
    userMessages,
  });
  const meetingPlanJson = JSON.stringify(plan);
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? chairBriefingPrompt({
            userBrief,
            meetingPlanJson,
            transcriptText,
            roundLabel,
          })
        : chairBriefingRetryPrompt({
            userBrief,
            meetingPlanJson,
            transcriptText,
            validationError: lastErr,
            roundLabel,
          });
    const { text, runId } = await runPromptForText(prompt, options);
    console.info("[board] chair briefing run", runId);
    try {
      return parseBriefingJson(text);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (attempt === 1) {
        throw new Error(`Invalid briefing JSON: ${lastErr}`);
      }
    }
  }
  throw new Error("Unreachable");
}

// keep parseMeetingPlanJson for tests/smoke
export { parseMeetingPlanJson, formatTranscriptForPrompt };
