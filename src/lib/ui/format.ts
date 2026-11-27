import type { PRStatus } from "@/types";

export const PR_STATUS_LABELS: Record<PRStatus, string> = {
  pending: "Pending",
  needs_setup: "Needs AI key",
  reviewing: "Reviewing",
  reviewed: "Reviewed",
  approved: "Approved",
  closed: "Closed",
  cancelled: "Cancelled",
};

export function timeAgo(date: Date, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - new Date(date).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
