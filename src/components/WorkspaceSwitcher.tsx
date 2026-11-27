"use client";

import { useRouter } from "next/navigation";

export default function WorkspaceSwitcher({
  current,
  workspaces,
}: {
  current: string;
  workspaces: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  return (
    <select
      aria-label="Workspace"
      data-testid="workspace-switcher"
      value={current}
      onChange={(e) => router.push(`/w/${e.target.value}`)}
    >
      {workspaces.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </select>
  );
}
