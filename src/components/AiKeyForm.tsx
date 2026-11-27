"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import panels from "@/styles/panels.module.css";

interface AiState {
  keyStatus: "missing" | "valid" | "invalid";
  keyLast4: string | null;
}

export default function AiKeyForm({
  workspaceId,
  initial,
  onSaved,
}: {
  workspaceId: string;
  initial: AiState;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [editing, setEditing] = useState(initial.keyStatus !== "valid");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function call(method: "PUT" | "DELETE", body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/w/${workspaceId}/ai-key`, {
        method,
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `Something went wrong (${res.status}).`);
        return false;
      }
      setState(data.ai);
      router.refresh();
      return true;
    } catch {
      setError("Network error. Check your connection and try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (await call("PUT", { key })) {
      setKey("");
      setEditing(false);
      onSaved?.();
    }
  }

  async function remove() {
    if (!confirm("Remove the AI key? Pull requests won't be reviewed until a new key is added.")) return;
    if (await call("DELETE")) setEditing(true);
  }

  if (!editing && state.keyLast4) {
    return (
      <div className={panels.orgRow} data-testid="ai-key-current">
        <span className={panels.orgIcon}>🔑</span>
        <div>
          <div className={panels.orgName}>Gemini API key</div>
          <div className={panels.maskedKey}>••••{state.keyLast4}</div>
        </div>
        <div className={panels.rowActions}>
          {state.keyStatus === "invalid" ? (
            <span className={panels.pendingBadge}>Rejected</span>
          ) : (
            <span className={panels.connectedBadge}>● Active</span>
          )}
          <button type="button" className={panels.secondaryBtn} onClick={() => setEditing(true)}>
            Replace
          </button>
          <button type="button" className={panels.dangerBtn} onClick={remove} disabled={busy}>
            Remove
          </button>
        </div>
        {error && <p className={panels.error} role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <form className={panels.form} onSubmit={save}>
      <label htmlFor="ai-key" className={panels.label}>
        Gemini API key
      </label>
      <div className={panels.inputRow}>
        <input
          id="ai-key"
          name="key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          className={panels.input}
          placeholder="AIza…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          aria-describedby="ai-key-hint ai-key-error"
          aria-invalid={!!error}
        />
        <button type="submit" className={panels.primaryBtn} disabled={busy || !key.trim()}>
          {busy ? "Checking…" : "Save key"}
        </button>
      </div>
      <p id="ai-key-error" className={panels.error} role="alert" aria-live="polite">
        {error}
      </p>
      <p id="ai-key-hint" className={panels.hint}>
        Get a key at{" "}
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">
          aistudio.google.com/apikey
        </a>
        . It&apos;s only used to review this workspace&apos;s pull requests, is stored encrypted, and is never shown
        again. Usage is billed to your Google account.
      </p>
      {state.keyLast4 && (
        <button type="button" className={panels.secondaryBtn} onClick={() => setEditing(false)}>
          Cancel
        </button>
      )}
    </form>
  );
}
