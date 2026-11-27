"use client";

import { useState } from "react";
import Link from "next/link";
import AiKeyForm from "./AiKeyForm";
import panels from "@/styles/panels.module.css";

export default function OnboardingAiStep({
  workspaceId,
  alreadyDone,
}: {
  workspaceId: string;
  alreadyDone: boolean;
}) {
  const [done, setDone] = useState(alreadyDone);

  if (done) {
    return (
      <div className={panels.card} data-testid="onboarding-ready" role="status">
        <div className={panels.sectionTitle}>🚢 You&apos;re ready</div>
        <p className={panels.sectionDesc}>
          Open a pull request in any repository the app can access. The review starts automatically and posts
          its findings on the PR.
        </p>
        <Link href={`/w/${workspaceId}`} className={panels.installBtn}>
          Go to overview
        </Link>
      </div>
    );
  }

  return (
    <AiKeyForm
      workspaceId={workspaceId}
      initial={{ keyStatus: "missing", keyLast4: null }}
      onSaved={() => setDone(true)}
    />
  );
}
