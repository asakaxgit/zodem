import { useMemo, useState } from "react";
import { createClient, ConnectError } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { z } from "zod";
import { zod, proto, codecs } from "@example/shared";

const transport = createConnectTransport({ baseUrl: "/" });
const client = createClient(proto.UserService, transport);

const requestCodec = codecs.get("acme.user.v1.CreateUserRequest")!;
const userCodec = codecs.get("acme.user.v1.User")!;

interface FormState {
  email: string;
  displayName: string;
  age: string;
  role: "admin" | "member";
  nickname: string;
  city: string;
  country: string;
}

const initialForm: FormState = {
  email: "",
  displayName: "",
  age: "",
  role: "member",
  nickname: "",
  city: "",
  country: "",
};

function toCandidate(form: FormState): unknown {
  return {
    email: form.email,
    displayName: form.displayName,
    age: Number(form.age),
    role: form.role,
    nickname: form.nickname.trim() === "" ? null : form.nickname,
    address: { city: form.city, country: form.country },
  };
}

export function App() {
  const [form, setForm] = useState<FormState>(initialForm);
  const [result, setResult] = useState<z.infer<typeof zod.User> | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Client-side validation with the exact same schema the server uses —
  // this is the guarantee the example exists to demonstrate.
  const validation = useMemo(() => zod.CreateUserRequest.safeParse(toCandidate(form)), [form]);
  const fieldErrors = validation.success ? {} : validation.error.flatten().fieldErrors;

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setServerError(null);
    setResult(null);
    if (!validation.success) return;

    setSubmitting(true);
    try {
      const initObject = requestCodec.encode(validation.data);
      const response = await client.createUser(initObject as never);
      if (response.user) {
        setResult(userCodec.decode(response.user as unknown as Record<string, unknown>) as z.infer<typeof zod.User>);
        setForm(initialForm);
      }
    } catch (err) {
      setServerError(err instanceof ConnectError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={{ maxWidth: 480, margin: "2rem auto", fontFamily: "system-ui, sans-serif" }}>
      <h1>zodem fullstack example</h1>
      <p>
        One Zod schema (<code>CreateUserRequest</code>) validates this form <em>and</em> the server's Connect
        handler. The request goes over the real Connect/protobuf wire protocol.
      </p>

      <form onSubmit={handleSubmit} style={{ display: "grid", gap: "0.75rem" }}>
        <Field label="Email" error={fieldErrors.email?.[0]}>
          <input value={form.email} onChange={(e) => update("email", e.target.value)} />
        </Field>
        <Field label="Display name" error={fieldErrors.displayName?.[0]}>
          <input value={form.displayName} onChange={(e) => update("displayName", e.target.value)} />
        </Field>
        <Field label="Age" error={fieldErrors.age?.[0]}>
          <input value={form.age} onChange={(e) => update("age", e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Role">
          <select value={form.role} onChange={(e) => update("role", e.target.value as FormState["role"])}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </Field>
        <Field label="Nickname (optional)">
          <input value={form.nickname} onChange={(e) => update("nickname", e.target.value)} />
        </Field>
        <Field label="City" error={fieldErrors.address?.[0]}>
          <input value={form.city} onChange={(e) => update("city", e.target.value)} />
        </Field>
        <Field label="Country (2-letter code)" error={fieldErrors.address?.[0]}>
          <input value={form.country} onChange={(e) => update("country", e.target.value)} maxLength={2} />
        </Field>

        <button type="submit" disabled={!validation.success || submitting}>
          {submitting ? "Creating…" : "Create user"}
        </button>
      </form>

      {serverError && <p style={{ color: "crimson" }}>Server rejected the request: {serverError}</p>}

      {result && (
        <section style={{ marginTop: "1.5rem", padding: "1rem", border: "1px solid #ccc", borderRadius: 8 }}>
          <h2>Created</h2>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </section>
      )}
    </main>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: "0.25rem" }}>
      <span>{label}</span>
      {children}
      {error && <span style={{ color: "crimson", fontSize: "0.85em" }}>{error}</span>}
    </label>
  );
}
