import type {
  ChairBriefing,
  Glossary,
  MeetingPlan,
  MeetingProposal,
  TranscriptTurn,
} from "./schemas";

export type TurnStartPayload = {
  id: number;
  roleId: string;
  roleName: string;
};

export type TurnDeltaPayload = {
  id: number;
  delta: string;
};

export type ChairStartPayload = {
  id: string;
  roundId: number;
};

export type ChairDeltaPayload = {
  id: string;
  delta: string;
  roundId: number;
};

export type BoardEmitEvent =
  | { type: "meeting_plan"; payload: MeetingPlan; roundId?: number }
  | { type: "meeting_proposal"; payload: MeetingProposal }
  | { type: "awaiting_user"; reason: "goal" | "roster" | "both" }
  | { type: "awaiting_brief" }
  | { type: "chair_start"; payload: ChairStartPayload }
  | { type: "chair_delta"; payload: ChairDeltaPayload }
  | { type: "chair_message"; payload: { id: string; content: string; roundId: number } }
  | { type: "turn_start"; payload: TurnStartPayload; roundId?: number }
  | { type: "turn_delta"; payload: TurnDeltaPayload; roundId?: number }
  | { type: "turn"; payload: TranscriptTurn; roundId?: number }
  | { type: "briefing"; payload: ChairBriefing; roundId?: number }
  | { type: "glossary"; payload: Glossary; roundId?: number };

export type BoardStreamEvent =
  | BoardEmitEvent
  | { type: "error"; message: string }
  | { type: "done" };

export type BoardRunResult = {
  meetingPlan: MeetingPlan;
  transcript: { turns: TranscriptTurn[] };
  briefing: ChairBriefing;
  glossary: Glossary;
};

export type StreamAction =
  | { action: "start" }
  | { action: "brief_reply"; message: string }
  | { action: "approve_proposal"; invitedRoleIds: string[] }
  | { action: "proposal_reply"; message: string }
  | { action: "follow_up"; message: string }
  | { action: "interrupt_discussion"; message: string; scheduleIndex: number }
  | { action: "resume_interrupted"; scheduleIndex: number };

export type StreamContext = {
  userBrief: string;
  meetingPlan: MeetingPlan | null;
  turns: TranscriptTurn[];
  briefing: ChairBriefing | null;
  glossary: Glossary | null;
  roundCount: number;
  pendingProposal: MeetingProposal | null;
  userMessages: { id: string; content: string; timestamp: number; roundId: number }[];
};

export type StreamingTurnState = {
  id: number;
  roleId: string;
  roleName: string;
  content: string;
  roundId: number;
};

export type StreamingChairState = {
  id: string;
  content: string;
  roundId: number;
};
