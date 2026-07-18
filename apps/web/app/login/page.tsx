import { redirect } from "next/navigation";

import { BrandMark } from "@/components/brand-mark";
import { authenticatedMerchant } from "@/lib/merchant-auth-page";
import { safeInternalPath } from "@/lib/safe-redirect";

export const dynamic = "force-dynamic";

type LoginPageProps = {
  searchParams: Promise<{ error?: string; next?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const next = safeInternalPath(params.next);
  if (await authenticatedMerchant()) redirect(next);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24
      }}
    >
      <form
        action="/api/pasarai/session"
        method="post"
        style={{
          width: "min(100%, 380px)",
          display: "grid",
          gap: 16,
          padding: 24,
          border: "1px solid var(--line)",
          borderRadius: "var(--radius-sm)",
          background: "var(--paper-raised)",
          boxShadow: "var(--shadow-paper)"
        }}
      >
        <span className="brand-lockup">
          <BrandMark />
          <span>
            <strong>PasarAI</strong>
            <small>Merchant access</small>
          </span>
        </span>
        <label style={{ display: "grid", gap: 6 }}>
          <strong>Access code</strong>
          <input
            autoComplete="current-password"
            autoFocus
            name="access_code"
            required
            type="password"
            style={{
              minHeight: 44,
              padding: "8px 10px",
              border: "1px solid var(--line-strong)",
              borderRadius: "var(--radius-sm)",
              background: "var(--paper)"
            }}
          />
        </label>
        <input name="next" type="hidden" value={next} />
        {params.error === "invalid" ? (
          <p role="alert" style={{ margin: 0, color: "var(--danger)" }}>
            The access code is not valid.
          </p>
        ) : null}
        <button
          type="submit"
          style={{
            minHeight: 44,
            border: 0,
            borderRadius: "var(--radius-sm)",
            color: "var(--paper)",
            background: "var(--sambal-deep)",
            fontWeight: 700,
            cursor: "pointer"
          }}
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
