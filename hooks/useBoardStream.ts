"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  BoardStreamEvent,
  StreamContext,
  StreamingChairState,
  StreamingTurnState,
} from "@/lib/board-events";
import {
  appendThreadItem,
  loadSession,
  markAutostart,
  patchSession,
  syncTurnToThread,
  type BoardSession,
} from "@/lib/session-store";
import { CHAIR_CONVENING_MESSAGE } from "@/lib/board-constants";
import {
  isTruncatedSentenceFragment,
  PLACEHOLDER_SESSION_TITLE,
  resolveSessionTitle,
} from "@/lib/session-title";
import type {
  ChairBriefing,
  Glossary,
  MeetingPlan,
  MeetingProposal,
  SessionTimelineEvent,
  ThreadItem,
  TranscriptTurn,
} from "@/lib/schemas";

export type StreamState = {
  title: string;
  brief: string;
  loading: boolean;
  error: string | null;
  meetingPlan: MeetingPlan | null;
  turns: TranscriptTurn[];
  briefing: ChairBriefing | null;
  glossary: Glossary | null;
  status: BoardSession["status"];
  phase: BoardSession["phase"];
  roundCount: number;
  timeline: SessionTimelineEvent[];
  thread: ThreadItem[];
  pendingProposal: MeetingProposal | null;
  userMessages: BoardSession["userMessages"];
  streamingTurn: StreamingTurnState | null;
  streamingChair: StreamingChairState | null;
};

function sessionToState(
  session: BoardSession,
  streaming = false,
  live: Pick<StreamState, "streamingTurn" | "streamingChair"> = {
    streamingTurn: null,
    streamingChair: null,
  },
): StreamState {
  return {
    title: session.title,
    brief: session.brief,
    loading: streaming || session.status === "running",
    error: session.error,
    meetingPlan: session.meetingPlan,
    turns: session.turns,
    briefing: session.briefing,
    glossary: session.glossary,
    status: session.status,
    phase: session.phase,
    roundCount: session.roundCount,
    timeline: session.timeline,
    thread: session.thread,
    pendingProposal: session.pendingProposal,
    userMessages: session.userMessages,
    streamingTurn: live.streamingTurn,
    streamingChair: live.streamingChair,
  };
}

function buildStreamContext(session: BoardSession): StreamContext {
  return {
    userBrief: session.brief,
    meetingPlan: session.meetingPlan,
    turns: session.turns,
    briefing: session.briefing,
    glossary: session.glossary,
    roundCount: session.roundCount,
    pendingProposal: session.pendingProposal,
    userMessages: session.userMessages,
  };
}

function appendChairThreadMessage(sessionId: string, content: string, roundId = 0) {
  appendThreadItem(sessionId, {
    kind: "chair",
    id: crypto.randomUUID(),
    content,
    timestamp: Date.now(),
    roundId,
  });
}

export function useBoardStream(sessionId: string) {
  const [revision, setRevision] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const [streamingTurn, setStreamingTurn] = useState<StreamingTurnState | null>(null);
  const [streamingChair, setStreamingChair] = useState<StreamingChairState | null>(null);
  const streamStartedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const bump = useCallback(() => setRevision((r) => r + 1), []);

  const session = loadSession(sessionId);
  const state = session
    ? sessionToState(session, streaming, { streamingTurn, streamingChair })
    : null;

  const consumeStream = useCallback(
    async (body: Record<string, unknown>) => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setStreaming(true);
      setStreamingTurn(null);
      setStreamingChair(null);
      patchSession(sessionId, { status: "running", error: null });
      bump();

      try {
        const res = await fetch("/api/board/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const ct = res.headers.get("content-type") ?? "";
        if (!res.ok || !ct.includes("ndjson")) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string };
          const message = errBody.error ?? `Request failed (${res.status})`;
          patchSession(sessionId, { status: "error", error: message });
          bump();
          return;
        }

        const bodyReader = res.body?.getReader();
        if (!bodyReader) {
          patchSession(sessionId, { status: "error", error: "No response body" });
          bump();
          return;
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let streamFinished = false;
        let lastRoundId = loadSession(sessionId)?.roundCount ?? 1;

        const applyEvent = (ev: BoardStreamEvent) => {
          const s = loadSession(sessionId);
          if (!s) return;

          switch (ev.type) {
            case "meeting_proposal": {
              const proposalItem: ThreadItem = {
                kind: "proposal",
                payload: ev.payload,
                status: "pending",
              };
              const threadWithoutPendingProposal = s.thread.filter(
                (t) => !(t.kind === "proposal" && t.status === "pending"),
              );
              const title = resolveSessionTitle(s.brief, ev.payload);
              patchSession(sessionId, {
                pendingProposal: ev.payload,
                status: "awaiting_user",
                phase: "kickstart",
                title,
                thread: [...threadWithoutPendingProposal, proposalItem],
              });
              break;
            }
            case "awaiting_brief":
              patchSession(sessionId, {
                status: "awaiting_brief",
                phase: "kickstart",
                pendingProposal: null,
              });
              break;
            case "awaiting_user":
              patchSession(sessionId, { status: "awaiting_user", phase: "kickstart" });
              break;
            case "meeting_plan": {
              const roundId = ev.roundId ?? s.roundCount + 1;
              lastRoundId = roundId;
              appendChairThreadMessage(
                sessionId,
                "Starting the discussion with your invited experts…",
                roundId,
              );
              const title =
                s.title === PLACEHOLDER_SESSION_TITLE ||
                !s.title.trim() ||
                isTruncatedSentenceFragment(s.title)
                  ? resolveSessionTitle(s.brief, {
                      sessionTitle: s.pendingProposal?.sessionTitle,
                    })
                  : s.title;
              patchSession(sessionId, {
                meetingPlan: ev.payload,
                pendingProposal: null,
                phase: roundId > 1 ? "follow_up" : "discussion",
                roundCount: Math.max(s.roundCount, roundId),
                status: "running",
                title,
              });
              break;
            }
            case "turn_start": {
              const roundId = ev.roundId ?? lastRoundId;
              lastRoundId = roundId;
              setStreamingTurn({
                id: ev.payload.id,
                roleId: ev.payload.roleId,
                roleName: ev.payload.roleName,
                content: "",
                roundId,
              });
              break;
            }
            case "turn_delta":
              setStreamingTurn((prev) =>
                prev && prev.id === ev.payload.id
                  ? { ...prev, content: prev.content + ev.payload.delta }
                  : prev,
              );
              break;
            case "turn": {
              const roundId = ev.roundId ?? lastRoundId;
              syncTurnToThread(sessionId, ev.payload, roundId);
              setStreamingTurn(null);
              break;
            }
            case "chair_start":
              setStreamingChair({
                id: ev.payload.id,
                content: "",
                roundId: ev.payload.roundId,
              });
              break;
            case "chair_delta":
              setStreamingChair((prev) =>
                prev && prev.id === ev.payload.id
                  ? { ...prev, content: prev.content + ev.payload.delta }
                  : prev,
              );
              break;
            case "chair_message": {
              const item: ThreadItem = {
                kind: "chair",
                id: ev.payload.id,
                content: ev.payload.content,
                timestamp: Date.now(),
                roundId: ev.payload.roundId,
              };
              appendThreadItem(sessionId, item);
              setStreamingChair(null);
              break;
            }
            case "briefing": {
              const roundId = ev.roundId ?? lastRoundId;
              appendChairThreadMessage(
                sessionId,
                "I'll wrap up with a briefing from this discussion…",
                roundId,
              );
              const briefingItem: ThreadItem = {
                kind: "briefing",
                roundId,
                payload: ev.payload,
              };
              patchSession(sessionId, {
                briefing: ev.payload,
                thread: [...(loadSession(sessionId)?.thread ?? s.thread), briefingItem],
              });
              break;
            }
            case "glossary": {
              patchSession(sessionId, {
                glossary: ev.payload,
              });
              break;
            }
            case "error":
              patchSession(sessionId, { status: "error", error: ev.message });
              setStreamingTurn(null);
              setStreamingChair(null);
              break;
            case "done":
              break;
            default:
              break;
          }
          bump();
        };

        while (!streamFinished) {
          const { done, value } = await bodyReader.read();
          if (value) buffer += decoder.decode(value, { stream: !done });
          if (done) buffer += decoder.decode();

          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let ev: BoardStreamEvent;
            try {
              ev = JSON.parse(line) as BoardStreamEvent;
            } catch {
              continue;
            }
            applyEvent(ev);
            if (ev.type === "done") {
              streamFinished = true;
              break;
            }
          }
          if (done) streamFinished = true;
        }

        if (streamFinished && !controller.signal.aborted) {
          const final = loadSession(sessionId);
          if (
            final &&
            final.status === "running" &&
            final.phase !== "kickstart"
          ) {
            patchSession(sessionId, { status: "idle", phase: "idle" });
            bump();
          }
        }
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          setStreamingTurn(null);
          setStreamingChair(null);
          return;
        }
        const message = e instanceof Error ? e.message : "Network error";
        patchSession(sessionId, { status: "error", error: message });
        setStreamingTurn(null);
        setStreamingChair(null);
        bump();
      } finally {
        setStreaming(false);
        bump();
      }
    },
    [sessionId, bump],
  );

  const runStream = useCallback(async () => {
    const current = loadSession(sessionId);
    if (!current?.brief.trim()) return;
    if (streamStartedRef.current) return;
    if (current.status === "idle" && current.glossary) return;
    if (current.status === "complete" && current.glossary) return;
    if (current.status === "awaiting_user") return;

    streamStartedRef.current = true;
    const hasConvening = current.thread.some(
      (t) => t.kind === "chair" && t.content === CHAIR_CONVENING_MESSAGE,
    );
    if (!hasConvening) {
      appendChairThreadMessage(sessionId, CHAIR_CONVENING_MESSAGE);
    }
    bump();
    await consumeStream({ action: "start", brief: current.brief });
  }, [sessionId, consumeStream, bump]);

  const approveProposal = useCallback(
    async (invitedRoleIds: string[]) => {
      const current = loadSession(sessionId);
      if (!current?.pendingProposal) return;

      const proposalItem: ThreadItem = {
        kind: "proposal",
        payload: current.pendingProposal,
        status: "approved",
        invitedRoleIds,
      };
      patchSession(sessionId, {
        thread: [...current.thread.filter((t) => t.kind !== "proposal"), proposalItem],
        status: "running",
      });
      bump();

      await consumeStream({
        action: "approve_proposal",
        invitedRoleIds,
        ...buildStreamContext(current),
      });
    },
    [sessionId, consumeStream, bump],
  );

  const sendBriefReply = useCallback(
    async (message: string) => {
      const current = loadSession(sessionId);
      if (!message.trim() || !current) return;

      const updatedBrief = `${current.brief}\n\n${message.trim()}`.trim();
      const userItem: ThreadItem = {
        kind: "user",
        id: crypto.randomUUID(),
        content: message.trim(),
        timestamp: Date.now(),
        roundId: 0,
      };
      patchSession(sessionId, {
        brief: updatedBrief,
        thread: [...current.thread, userItem],
        status: "running",
      });
      bump();

      await consumeStream({
        action: "brief_reply",
        message: message.trim(),
        ...buildStreamContext({ ...current, brief: updatedBrief }),
      });
    },
    [sessionId, consumeStream, bump],
  );

  const sendProposalReply = useCallback(
    async (message: string) => {
      const current = loadSession(sessionId);
      if (!current?.pendingProposal || !message.trim()) return;

      const userItem: ThreadItem = {
        kind: "user",
        id: crypto.randomUUID(),
        content: message.trim(),
        timestamp: Date.now(),
        roundId: 0,
      };
      patchSession(sessionId, {
        thread: [...current.thread, userItem],
        status: "running",
      });
      appendChairThreadMessage(
        sessionId,
        "I'll revise the roster based on your feedback…",
      );
      bump();

      await consumeStream({
        action: "proposal_reply",
        message: message.trim(),
        ...buildStreamContext(current),
      });
    },
    [sessionId, consumeStream, bump],
  );

  const sendFollowUp = useCallback(
    async (message: string) => {
      const current = loadSession(sessionId);
      if (!current || !message.trim()) return;
      if (!current.meetingPlan) return;

      const roundId = current.roundCount + 1;
      const userItem: ThreadItem = {
        kind: "user",
        id: crypto.randomUUID(),
        content: message.trim(),
        timestamp: Date.now(),
        roundId,
      };
      const userMsg = {
        id: userItem.id,
        content: userItem.content,
        timestamp: userItem.timestamp,
        roundId,
      };

      patchSession(sessionId, {
        thread: [...current.thread, userItem],
        userMessages: [...current.userMessages, userMsg],
        status: "running",
        phase: "follow_up",
      });
      bump();

      await consumeStream({
        action: "follow_up",
        message: message.trim(),
        ...buildStreamContext(loadSession(sessionId)!),
      });
    },
    [sessionId, consumeStream, bump],
  );

  const interruptDiscussion = useCallback(
    async (message: string) => {
      const current = loadSession(sessionId);
      if (!current?.meetingPlan || !message.trim()) return;

      abortControllerRef.current?.abort();

      const roundId = current.roundCount || 1;
      const scheduleIndex = current.thread.filter(
        (t) => t.kind === "expert" && t.roundId === roundId,
      ).length;

      const userItem: ThreadItem = {
        kind: "user",
        id: crypto.randomUUID(),
        content: message.trim(),
        timestamp: Date.now(),
        roundId,
      };

      const userMsg = {
        id: userItem.id,
        content: userItem.content,
        timestamp: userItem.timestamp,
        roundId,
      };

      patchSession(sessionId, {
        thread: [...current.thread, userItem],
        userMessages: [...current.userMessages, userMsg],
        status: "running",
        phase: "discussion",
      });
      setStreamingTurn(null);
      setStreamingChair(null);
      bump();

      await consumeStream({
        action: "interrupt_discussion",
        message: message.trim(),
        scheduleIndex,
        ...buildStreamContext(loadSession(sessionId)!),
      });
    },
    [sessionId, consumeStream, bump],
  );



    const resumeInterruptedSession = useCallback(async () => {
      const current = loadSession(sessionId);
    
      if (!current?.meetingPlan || current.phase !== "discussion") return;
    
      const roundId = current.roundCount || 1;
    
      const scheduleIndex = current.thread.filter(
        (t) => t.kind === "expert" && t.roundId === roundId,
      ).length;
    
      patchSession(sessionId, {
        status: "running",
        error: null,
        phase: "discussion",
      });
    
      setStreamingTurn(null);
      setStreamingChair(null);
      bump();
    
      await consumeStream({
        action: "resume_interrupted",
        scheduleIndex,
        ...buildStreamContext(current),
      });
    }, [sessionId, consumeStream, bump]);
    
    
    

  
    useEffect(() => {
      streamStartedRef.current = false;
    
      const s = loadSession(sessionId);
      if (!s) return;
    
      const shouldAutostart = markAutostart(sessionId);
    
      if (
        shouldAutostart &&
        s.status === "running" &&
        !s.glossary &&
        !s.pendingProposal
      ) {
        queueMicrotask(() => {
          void runStream();
        });
        return;
      }
    
      if (
        !shouldAutostart &&
        s.status === "running" &&
        s.phase === "discussion" &&
        s.meetingPlan &&
        !s.pendingProposal
      ) {
        patchSession(sessionId, {
          status: "error",
          error:
            "Discussion was interrupted. Resume to continue from the last completed expert turn.",
        });
    
        bump();
      }
    }, [sessionId, runStream, bump]);

  
    return {
      state,
      revision,
      runStream,
      approveProposal,
      sendBriefReply,
      sendProposalReply,
      sendFollowUp,
      interruptDiscussion,
      resumeInterruptedSession,
    };
}
