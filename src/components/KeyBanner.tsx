"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import panels from "@/styles/panels.module.css";

/** Owner-only nudge about the AI key; hidden on onboarding, which is the fix. */
export default function KeyBanner({
  workspaceId,
  keyStatus,
}: {
  workspaceId: string;
  keyStatus: "missing" | "valid" | "invalid";
}) {
  const pathname = usePathname();
  const base = `/w/${workspaceId}`;
  if (keyStatus === "valid" || pathname.startsWith(`${base}/onboarding`)) return null;

  if (keyStatus === "invalid") {
    return (
      <div className={panels.banner} role="alert" data-testid="key-banner">
        Your Gemini API key was rejected, so reviews are paused.{" "}
        <Link href={`${base}/settings`}>Replace the key</Link>.
      </div>
    );
  }
  return (
    <div className={`${panels.banner} ${panels.bannerWarning}`} role="status" data-testid="key-banner">
      No AI key yet, so pull requests aren&apos;t being reviewed. <Link href={`${base}/onboarding`}>Finish setup</Link>.
    </div>
  );
}
