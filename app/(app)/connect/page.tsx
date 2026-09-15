"use client";

import { useState, useSyncExternalStore } from "react";
import Tokens from "@/components/Tokens";

/**
 * How to point an assistant at this workspace.
 *
 * The instructions are generated from wherever the app is actually served, so
 * they are correct for whoever is reading them rather than correct for the
 * machine they were written on.
 */

const CLIENTS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "claude-desktop", label: "Claude Desktop" },
  { id: "claude-remote", label: "Claude (no install)" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "cli", label: "Command line" },
] as const;
type ClientId = typeof CLIENTS[number]["id"];

/** The address people should actually type, read from where they are. The
 *  server can't know it, so it renders the canonical one and the client
 *  corrects it after hydration. */
const subscribeOrigin = () => () => {};
const readOrigin = () => window.location.origin;
const serverOrigin = () => "https://particlstudio.com";

export default function ConnectPage() {
  const origin = useSyncExternalStore(subscribeOrigin, readOrigin, serverOrigin);
  const [client, setClient] = useState<ClientId>("claude-code");
  const [token, setToken] = useState("");

  // Whatever they just minted gets pasted into the snippets automatically.
  const key = token || "aw_your_token_here";
  const bridge = `${origin}/particl-mcp.mjs`;

  return (
    <div className="screen">
      <div className="mx-auto w-full max-w-[720px]">
        <h1 className="h1 pt-6">Connect</h1>
        <p className="mt-3 max-w-[560px] text-[16px] leading-relaxed text-dim">
          Point Claude, ChatGPT or a terminal at this workspace and let it write shots,
          wait for them, and pull the files down — without opening the app.
        </p>

        {/* 1 ─ the key */}
        <p className="grouplabel mt-10">Step 1 · Make a token</p>
        <Tokens onNewToken={setToken} />
        <p className="px-[18px] pt-2.5 text-[13px] leading-relaxed text-mute">
          A token acts as you: its renders appear under your name, in the project you ask
          for, and on the ledger. Give it a monthly ceiling — that is what stops an assistant
          in a loop from spending more than you meant. Read-only tokens can look and download
          but are refused a render.
          {token && <span className="text-blue"> Your new token is filled into the steps below.</span>}
        </p>

        {/* 2 ─ the client */}
        <p className="grouplabel mt-10">Step 2 · Connect your assistant</p>
        <div className="mb-4 flex flex-wrap gap-2">
          {CLIENTS.map((c) => (
            <button key={c.id} onClick={() => setClient(c.id)}
              className={`rounded-full px-3.5 py-[7px] text-[13.5px] font-medium transition-colors ${
                client === c.id ? "bg-blue text-on-ink" : "bg-chip text-dim hover:bg-chip2"
              }`}>
              {c.label}
            </button>
          ))}
        </div>

        {client === "claude-code" && (
          <Guide
            note="One command. Claude Code runs the little connector for you."
            steps={[
              { text: "Download the connector (once):", code: `curl -o ~/particl-mcp.mjs ${bridge}` },
              { text: "Register it with Claude Code:", code:
`claude mcp add particl \\
  --env PARTICL_URL=${origin} \\
  --env PARTICL_TOKEN=${key} \\
  -- node ~/particl-mcp.mjs` },
              { text: "Check it before relying on it:", code:
`PARTICL_URL=${origin} PARTICL_TOKEN=${key} \\
  node ~/particl-mcp.mjs --check` },
            ]}
          />
        )}

        {client === "claude-desktop" && (
          <Guide
            note="Settings → Developer → Edit Config, then restart Claude Desktop."
            steps={[
              { text: "Download the connector (once):", code: `curl -o ~/particl-mcp.mjs ${bridge}` },
              { text: "Add this to claude_desktop_config.json:", code:
`{
  "mcpServers": {
    "particl": {
      "command": "node",
      "args": ["${"$HOME"}/particl-mcp.mjs"],
      "env": {
        "PARTICL_URL": "${origin}",
        "PARTICL_TOKEN": "${key}"
      }
    }
  }
}` },
            ]}
          />
        )}

        {client === "claude-remote" && (
          <Guide
            note="Nothing to download — this workspace is itself an MCP server. Add it as a custom connector wherever your Claude offers one (Settings → Connectors → Add custom connector)."
            steps={[
              { text: "Connector URL:", code: `${origin}/api/mcp` },
              { text: "Authentication — a bearer token:", code: key },
            ]}
            after="Custom connectors aren't available on every Claude plan. If yours doesn't offer one, use the Claude Code or Claude Desktop route instead — same tools, same workspace."
          />
        )}

        {client === "chatgpt" && (
          <Guide
            note="ChatGPT reaches the workspace as a Custom GPT Action. Create a GPT (ChatGPT → Explore GPTs → Create), open Configure → Actions → Create new action."
            steps={[
              { text: "Import the schema from this URL:", code: `${origin}/api/openapi` },
              { text: "Authentication → API Key → Bearer. Paste:", code: key },
            ]}
            after="If your ChatGPT offers custom connectors (MCP) instead, point it at the same endpoint the Claude route uses — /api/mcp with the same bearer token."
          />
        )}

        {client === "cli" && (
          <Guide
            note="The same connector works by hand — useful for batching a shot list."
            steps={[
              { text: "Download it once, and keep the two variables in your shell:", code:
`curl -o ~/particl-mcp.mjs ${bridge}
export PARTICL_URL=${origin}
export PARTICL_TOKEN=${key}` },
              { text: "Then:", code:
`node ~/particl-mcp.mjs --check
node ~/particl-mcp.mjs projects
node ~/particl-mcp.mjs usage
node ~/particl-mcp.mjs ls --project "Monsoon Film"
node ~/particl-mcp.mjs render "slow dolly through monsoon rain" --wait
node ~/particl-mcp.mjs get gen_abc123 --save ./shot.mp4` },
            ]}
          />
        )}

        {/* 3 ─ what it can do */}
        <p className="grouplabel mt-10">Step 3 · Ask for something</p>
        <div className="card p-5">
          <p className="text-[15px] leading-relaxed text-dim">
            Once it is connected, plain language is the whole interface. Projects are
            addressed by name, so this works:
          </p>
          <p className="mt-3 rounded-[12px] bg-panel2 px-4 py-3 text-[15px] leading-relaxed">
            “Render three variations of a slow dolly through monsoon rain on Marine Drive
            at 1080p, put them in Monsoon Film, and save the best one to my desktop when
            they’re done.”
          </p>
          <div className="mt-4 grid gap-x-6 gap-y-1.5 text-[14px] sm:grid-cols-2">
            {[
              ["render_shot", "starts a render"],
              ["wait_for_render", "waits, then reports the cost"],
              ["get_render", "details, and saves the file"],
              ["list_renders", "recent work, searchable"],
              ["list_projects", "projects, counts and spend"],
              ["create_project", "makes a new one"],
              ["usage_summary", "spend and remaining credit"],
            ].map(([n, what]) => (
              <p key={n} className="flex gap-2">
                <span className="font-mono text-[13px] text-blue">{n}</span>
                <span className="text-mute">{what}</span>
              </p>
            ))}
          </div>
        </div>

        <div className="card mt-4 p-5">
          <p className="text-[15px] font-semibold">Worth knowing</p>
          <ul className="mt-2 flex flex-col gap-2 text-[14px] leading-relaxed text-dim">
            <li>· Every render spends real credit at the rates the Usage page shows. The
              ceiling on the token is what bounds it.</li>
            <li>· Prompts are auto-refined with ByteDance&apos;s recipe, exactly as in the app.
              Start a prompt with <span className="font-mono text-[13px] text-blue">raw:</span> to
              send your exact words.</li>
            <li>· Revoking a token stops whatever is using it on its next request.</li>
            <li>· Media links need the token too — nothing here is public.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function Guide({ note, steps, after }: {
  note: string;
  steps: { text: string; code: string }[];
  after?: string;
}) {
  return (
    <div className="card p-5">
      <p className="text-[15px] leading-relaxed text-dim">{note}</p>
      <ol className="mt-4 flex flex-col gap-4">
        {steps.map((s, i) => (
          <li key={i}>
            <p className="text-[14px] font-medium">{i + 1}. {s.text}</p>
            <Code text={s.code} />
          </li>
        ))}
      </ol>
      {after && <p className="mt-4 text-[13.5px] leading-relaxed text-mute">{after}</p>}
    </div>
  );
}

function Code({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative mt-2">
      <pre className="overflow-x-auto rounded-[12px] bg-panel2 px-3.5 py-3 pr-20 font-mono text-[12.5px] leading-relaxed text-bone">
{text}
      </pre>
      <button
        onClick={async () => {
          try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600); }
          catch { /* select it by hand */ }
        }}
        className="chip absolute right-2 top-2 !py-1.5 !text-[12.5px]"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
