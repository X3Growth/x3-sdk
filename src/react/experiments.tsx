"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { tracker } from "../instance";
import type { ExperimentInfo } from "../types";

/**
 * Experiments in React (EXPERIMENTS.md §7.3). `useVariant` renders control until the assignment is
 * known (or the server's assignment from <X3Experiments>, so the first client render equals the
 * server render – no hydration mismatch, no flicker) and re-renders when it arrives. Exposure is
 * logged after commit, once per pageview, unless `expose: false` (then useExpose/expose()).
 */

type ServerAssignment = { arm: string; reason?: string; params?: Record<string, unknown> };
const AssignmentsContext = createContext<Record<string, ServerAssignment>>({});

/** Provides server-side assignments (getAssignments from @x3growth/sdk/next) to useVariant */
export function X3Experiments({ assignments, children }: { assignments?: Record<string, ServerAssignment> | null; children?: ReactNode }) {
  return <AssignmentsContext.Provider value={assignments ?? {}}>{children}</AssignmentsContext.Provider>;
}

export type VariantState = { arm: string; params: Record<string, unknown>; inExperiment: boolean; reason: ExperimentInfo["reason"]; ready: boolean };

function fromServer(assignment: ServerAssignment): VariantState {
  return { arm: assignment.arm, params: assignment.params ?? {}, inExperiment: assignment.reason === "assigned" || assignment.reason === "override", reason: (assignment.reason ?? "assigned") as ExperimentInfo["reason"], ready: true };
}

function current(key: string): VariantState {
  const info = tracker.experiment(key);
  return { arm: info.arm, params: info.params, inExperiment: info.inExperiment, reason: info.reason, ready: info.reason !== "pending" };
}

export function useVariant(key: string, options: { expose?: boolean } = {}): VariantState {
  const server = useContext(AssignmentsContext)[key];
  const [state, setState] = useState<VariantState>(() => (server ? fromServer(server) : { arm: "control", params: {}, inExperiment: false, reason: "pending", ready: false }));
  useEffect(() => {
    let active = true;
    const update = () => {
      if (!active) return;
      const next = current(key);
      // the server's arm stays until the browser knows the visitor (same unit, same arm)
      if (server && next.reason === "pending") return;
      setState((previous) => (previous.arm === next.arm && previous.reason === next.reason && previous.ready === next.ready ? previous : next));
    };
    update();
    const off = tracker.experiments.onChange((changed) => changed === key && update());
    void tracker.experiments.ready().then(update);
    return () => {
      active = false;
      off();
    };
  }, [key]);
  const expose = options.expose !== false;
  useEffect(() => {
    if (expose && state.inExperiment) tracker.expose(key);
  }, [key, expose, state.inExperiment, state.arm]);
  return state;
}

/** Logs the exposure when `visible` becomes true (e.g. the contact step rendered) */
export function useExpose(key: string, visible = true): void {
  useEffect(() => {
    if (visible) tracker.expose(key);
  }, [key, visible]);
}

/** Renders its children only for one arm: <Variant experiment="quiz-contact-split" arm="split">…</Variant> */
export function Variant({ experiment, arm, expose, children }: { experiment: string; arm: string; expose?: boolean; children?: ReactNode }) {
  const state = useVariant(experiment, { expose });
  return state.arm === arm ? <>{children}</> : null;
}
