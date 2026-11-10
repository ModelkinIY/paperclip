import type { IssuePodMutexState } from "@paperclipai/shared";
import { Lock } from "lucide-react";
import { cn } from "../lib/utils";

/** inferdyne fork: pod mutex text for an issue's tree (holder / waiting). */
export function podMutexBadgeText(state: IssuePodMutexState) {
  if (state.role === "holder") return `${state.labelName} · holding`;
  if (state.role === "waiting") {
    return `${state.labelName} · waiting for ${state.holderIdentifier ?? state.holderRootIssueId ?? "another task"}`;
  }
  return `${state.labelName} · free`;
}

/** Small badge for the pod mutex of an issue's tree; renders nothing when free/absent. */
export function PodMutexBadge({ state, className, showFree = false }: {
  state: IssuePodMutexState | null | undefined;
  className?: string;
  showFree?: boolean;
}) {
  if (!state || (state.role === "free" && !showFree)) return null;
  const text = podMutexBadgeText(state);
  return (
    <span
      data-slot="pod-mutex-badge"
      data-role={state.role}
      title={text}
      className={cn(
        "inline-flex min-w-0 max-w-full shrink items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
        state.role === "holder" && "border-(--status-task-icon-done)/40 text-(--status-task-icon-done)",
        state.role === "waiting" && "border-(--status-task-icon-todo)/40 text-(--status-task-icon-todo)",
        state.role === "free" && "text-muted-foreground",
        className,
      )}
    >
      <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{text}</span>
    </span>
  );
}
