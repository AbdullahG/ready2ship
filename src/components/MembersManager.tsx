"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import panels from "@/styles/panels.module.css";

export interface PublicMember {
  id: string;
  login: string;
  role: "owner" | "member";
  status: "pending" | "active";
}

export default function MembersManager({
  workspaceId,
  initial,
  canManage,
  currentLogin,
}: {
  workspaceId: string;
  initial: PublicMember[];
  canManage: boolean;
  currentLogin: string;
}) {
  const router = useRouter();
  const [members, setMembers] = useState(initial);
  const [login, setLogin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function call(url: string, method: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `Something went wrong (${res.status}).`);
        return false;
      }
      setMembers(data.members);
      router.refresh();
      return true;
    } catch {
      setError("Network error. Check your connection and try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const base = `/api/w/${workspaceId}/members`;

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (await call(base, "POST", { login })) setLogin("");
  }

  return (
    <div>
      {canManage && (
        <form className={panels.form} onSubmit={invite} style={{ marginBottom: 16 }}>
          <label htmlFor="invite-login" className={panels.label}>
            Invite by GitHub username
          </label>
          <div className={panels.inputRow}>
            <input
              id="invite-login"
              className={panels.input}
              placeholder="@username"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" className={panels.primaryBtn} disabled={busy || !login.trim()}>
              Invite
            </button>
          </div>
          <p className={panels.hint}>They get access the next time they sign in with GitHub.</p>
        </form>
      )}

      <p className={panels.error} role="alert" aria-live="polite" data-testid="members-error">
        {error}
      </p>

      <div className={panels.orgList} data-testid="members-list">
        {members.map((m) => (
          <div key={m.id} className={panels.orgRow} data-testid={`member-${m.login}`}>
            <span className={panels.orgIcon} aria-hidden>👤</span>
            <span className={panels.orgName}>
              @{m.login}
              {m.login === currentLogin.toLowerCase() && <span className={panels.orgMeta}> (you)</span>}
            </span>
            <div className={panels.rowActions}>
              {m.status === "pending" && <span className={panels.pendingBadge}>Invited</span>}
              {canManage ? (
                <>
                  <select
                    className={panels.select}
                    aria-label={`Role for @${m.login}`}
                    value={m.role}
                    disabled={busy}
                    onChange={(e) => call(`${base}/${m.id}`, "PATCH", { role: e.target.value })}
                  >
                    <option value="owner">Owner</option>
                    <option value="member">Member</option>
                  </select>
                  <button
                    type="button"
                    className={panels.dangerBtn}
                    disabled={busy}
                    aria-label={`Remove @${m.login}`}
                    onClick={() => call(`${base}/${m.id}`, "DELETE")}
                  >
                    Remove
                  </button>
                </>
              ) : (
                <span className={panels.roleBadge}>{m.role}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
