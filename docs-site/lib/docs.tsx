import type { ReactNode } from "react";
import { CodeBlock } from "@/components/code-block";

export type DocPage = {
  slug: string;
  title: string;
  section: string;
  description: string;
  headings: Array<{ id: string; label: string }>;
  content: ReactNode;
};

function Callout({
  title,
  warning = false,
  children,
}: {
  title: string;
  warning?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`callout${warning ? " warning" : ""}`}>
      <strong>{title}</strong>
      {children}
    </div>
  );
}

function Table({
  headers,
  rows,
}: {
  headers: string[];
  rows: ReactNode[][];
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Rust and C++ are separate pages so each one appears in the sidebar next to
// the Python, Node, and JVM guides. They are close enough that a reader
// sometimes wants the other, so this strip links between them without a trip
// back to the sidebar. Plain anchors rather than a client component: both
// pages are prerendered, so switching language is a navigation, not state.
function LanguageSwitch({ current }: { current: "rust" | "cpp" }) {
  const options = [
    { id: "rust", label: "Rust", href: "/docs/rust" },
    { id: "cpp", label: "C++", href: "/docs/cpp" },
  ] as const;

  return (
    <nav className="tab-list" aria-label="Choose a language">
      {options.map((option) => (
        <a
          key={option.id}
          href={option.href}
          className={option.id === current ? "tab is-active" : "tab"}
          aria-current={option.id === current ? "page" : undefined}
        >
          {option.label}
        </a>
      ))}
    </nav>
  );
}

function NativeHowItWorks() {
  return (
    <>
      <h2 id="how-it-works">How it works</h2>
      <p>
        There is no package to add to your build. A host-level agent attaches
        eBPF uprobes to the binary you already deployed, so your service is
        untouched and never links against LiveProbe.
      </p>
      <p>
        That makes this a <strong>per-host install</strong>, not a per-service
        dependency. Set it up once on a machine and it covers every compiled
        service running there.
      </p>
      <p>Two processes run per host:</p>
      <Table
        headers={["Process", "Runs as", "Job"]}
        rows={[
          [
            <code key="l">liveprobe-bpf-loader</code>,
            "root",
            "Loads the BPF program and attaches uprobes. The only privileged part.",
          ],
          [
            <code key="a">liveprobe-native-agent</code>,
            <code key="u">liveprobe</code>,
            "Talks to the broker, streams evidence. No BPF privileges.",
          ],
        ]}
      />
      <Callout title="Never give the agent BPF privileges" warning>
        <p>
          The loader is the only process that should hold <code>CAP_BPF</code>{" "}
          or <code>CAP_SYS_ADMIN</code>. They talk over a root-owned Unix
          socket, and that split is what stops a compromised agent from loading
          arbitrary kernel programs.
        </p>
      </Callout>
    </>
  );
}

function NativeDebugInfo() {
  return (
    <>
      <h2 id="debug-info">Debug info you need</h2>
      <p>
        Probes are placed at source lines, so the binary has to explain itself
        to the agent. Two things must survive your build:
      </p>
      <Table
        headers={["What", "Why", "Check"]}
        rows={[
          [
            "DWARF",
            "Maps source lines to addresses, and names local variables.",
            <code key="1">readelf --sections app | grep debug_info</code>,
          ],
          [
            "GNU build ID",
            "Identifies which exact binary is running.",
            <code key="2">readelf --notes app | grep &apos;Build ID:&apos;</code>,
          ],
        ]}
      />
      <p>
        A stripped binary cannot be probed. Optimized release builds are fine —
        inlined code resolves to its inlined site. If you ship stripped
        binaries, keep the separate debug files and point{" "}
        <code>symbolDirectories</code> at them, or serve them from a{" "}
        <code>debuginfod</code>.
      </p>
    </>
  );
}

function NativeTroubleshooting() {
  return (
    <>
      <h2 id="troubleshooting">Troubleshooting</h2>
      <Table
        headers={["Symptom", "Fix"]}
        rows={[
          [<code key="a">no such user: liveprobe</code>, "Run step 4."],
          [
            "Service never appears",
            "No running process matches executablePath, or it differs from the loader allowlist.",
          ],
          [
            "Probe stays pending",
            "No DWARF for that line. The binary was stripped or built without -g / debug = 2.",
          ],
          [
            "Loader refuses a path",
            "That executable was not in the allowlist the loader started with.",
          ],
          [
            "Permission denied on the socket",
            "/run/liveprobe ownership does not match the UID/GID passed to the loader.",
          ],
        ]}
      />
      <p>
        Native probes are read-only: capture never writes to target memory, and
        a probe that hits its limit detaches instead of silently re-arming.
      </p>
    </>
  );
}

// Each language tab on the native page is a complete standalone path, so a
// reader never has to leave their tab to find a step. Only the build step and
// one config value actually differ, so the shared steps live here once and are
// parameterized. Duplicating them in the two tabs would let them drift.
function NativeSetupPath({
  language,
  buildStep,
}: {
  language: "rust" | "cpp";
  buildStep: ReactNode;
}) {
  return (
    <>
      <h3>1. Check the kernel</h3>
      <CodeBlock
        language="shell"
        code={`uname -m                                   # x86_64
test -r /sys/kernel/btf/vmlinux && echo "BTF ok"
mountpoint -q /sys/kernel/tracing ||
  sudo mount -t tracefs tracefs /sys/kernel/tracing
sudo test -e /sys/kernel/tracing/uprobe_events && echo "uprobes ok"`}
      />
      <p>
        Most current distro kernels pass. Containers usually do not, so run the
        agent on the host.
      </p>

      <h3>2. Build your service with debug info</h3>
      {buildStep}

      <h3>3. Install the agent</h3>
      <p>
        No published package yet — build both binaries from the repository on a
        machine matching the target host. Needs Rust 1.88+.
      </p>
      <CodeBlock
        language="shell"
        code={`sudo apt-get install -y --no-install-recommends \\
  build-essential pkg-config clang llvm lld bpftool \\
  libbpf-dev libelf-dev zlib1g-dev dwarves

make native-release
sudo make native-install`}
      />
      <p>
        Installs both binaries to <code>/usr/local/bin</code> and creates{" "}
        <code>/etc/liveprobe</code>. Override with <code>NATIVE_PREFIX</code> or
        stage a package with <code>DESTDIR</code>.
      </p>

      <h3>4. Create the unprivileged account</h3>
      <CodeBlock
        language="shell"
        code={`sudo useradd --system --no-create-home --shell /usr/sbin/nologin liveprobe
sudo install -d -o root -g liveprobe -m 0750 /run/liveprobe`}
      />

      <h3>5. Get a credential</h3>
      <p>
        Native agents use their own credential, not your operator key. It is
        shown once, and it only works for the services you list here.
      </p>
      <CodeBlock
        language="shell"
        code={`umask 077
curl --fail --silent --show-error \\
  -H "Authorization: Bearer $LIVEPROBE_API_KEY" \\
  -H "Content-Type: application/json" \\
  --data '{"agentId":"native-host-1","allowedServiceIds":["my-service"],"label":"Prod host 1"}' \\
  https://liveprobe.tryastrea.tech/v1/native-credentials`}
      />

      <h3>6. Write the config</h3>
      <p>
        Save this as <code>/etc/liveprobe/native-agent.json</code>. Use the real
        executable path, not a symlink or wrapper script.
      </p>
      <CodeBlock
        language="json"
        code={`{
  "agentId": "native-host-1",
  "brokerUrl": "https://liveprobe.tryastrea.tech",
  "loaderSocket": "/run/liveprobe/loader.sock",
  "services": [
    { "serviceId": "my-service", "language": "${language}", "executablePath": "/opt/app/bin/my-service" }
  ],
  "redactKeys": ["tenantSecret"],
  "redactValues": [],
  "symbolDirectories": ["/usr/lib/debug"],
  "debuginfodUrl": null,
  "symbolCacheDirectory": null
}`}
      />

      <h3>7. Start the loader, then the agent</h3>
      <CodeBlock
        language="shell"
        code={`# Loader first. The trailing paths are the allowlist -- it will
# attach to nothing else, so add a service here to probe it.
sudo /usr/local/bin/liveprobe-bpf-loader \\
  /run/liveprobe/loader.sock \\
  "$(id -u liveprobe)" "$(id -g liveprobe)" \\
  /opt/app/bin/my-service

# Then the agent, as the unprivileged account.
sudo -u liveprobe env \\
  LIVEPROBE_NATIVE_CREDENTIAL="lp_native_<secret>" \\
  /usr/local/bin/liveprobe-native-agent /etc/liveprobe/native-agent.json`}
      />
      <p>
        Both are long-running host daemons, so in production run them under
        systemd with the loader ordered first, and load the credential from an{" "}
        <code>EnvironmentFile</code> only root can read.
      </p>

      <h3>8. Verify</h3>
      <CodeBlock
        language="shell"
        code={`curl --fail --silent \\
  -H "Authorization: Bearer $LIVEPROBE_API_KEY" \\
  https://liveprobe.tryastrea.tech/v1/services | jq '.'`}
      />
      <p>
        Your <code>serviceId</code> appears once the agent registers and finds a
        running process. Now place a probe from your MCP client and you are
        done.
      </p>
    </>
  );
}

const hostedMcpConfig = `{
  "mcpServers": {
    "liveprobe": {
      "url": "https://liveprobe.tryastrea.tech/mcp"
    }
  }
}`;

const commonRuntimeEnv = `LIVEPROBE_BROKER_URL=https://liveprobe.tryastrea.tech
LIVEPROBE_PROJECT_ID=acme
LIVEPROBE_ENVIRONMENT=production
LIVEPROBE_SERVICE_ID=api
LIVEPROBE_API_KEY=lp_service_<shown-once-secret>
LIVEPROBE_COMMIT_SHA=<deployed-git-sha>`;

export const docs: DocPage[] = [
  {
    slug: "quickstart",
    title: "Quickstart",
    section: "Get started",
    description:
      "Connect your workspace, issue a scoped runtime credential, start one agent, and verify the complete LiveProbe path.",
    headings: [
      { id: "before-you-start", label: "Before you start" },
      { id: "connect-mcp", label: "Connect MCP" },
      { id: "create-runtime-identity", label: "Create runtime identity" },
      { id: "start-agent", label: "Start an agent" },
      { id: "verify", label: "Verify the connection" },
    ],
    content: (
      <>
        <h2 id="before-you-start">Before you start</h2>
        <p>
          You need an invitation to a LiveProbe Clerk workspace, an MCP client
          that supports remote OAuth servers, and access to the deployment
          configuration for the service you want to observe. Runtime agents
          support Node.js 20+, Python 3.12+, and Java 17+.
        </p>
        <Callout title="Use the deployed revision">
          <p>
            Every runtime agent refuses to start without a concrete hexadecimal
            commit SHA. Supply the revision that built the deployed process, not
            an arbitrary local checkout.
          </p>
        </Callout>

        <h2 id="connect-mcp">1. Connect the hosted MCP server</h2>
        <p>Add the production endpoint to Cursor or another OAuth MCP client:</p>
        <CodeBlock code={hostedMcpConfig} language="json" />
        <p>
          Choose <strong>Login</strong>, sign in through Clerk, and select the
          workspace you were invited to. No shared API key or local npm package
          is needed for hosted MCP access.
        </p>

        <h2 id="create-runtime-identity">2. Create a runtime identity</h2>
        <p>Ask the connected LiveProbe MCP server to perform these steps:</p>
        <ol className="steps">
          <li>
            <strong>Create a project</strong>
            Use one stable ID for the repository or application, such as{" "}
            <code>acme</code>.
          </li>
          <li>
            <strong>Create an environment</strong>
            Add a deployment target such as <code>staging</code> or{" "}
            <code>production</code>.
          </li>
          <li>
            <strong>Register a service</strong>
            Use one stable service ID for each independently deployed process,
            such as <code>api</code> or <code>worker</code>.
          </li>
          <li>
            <strong>Create a service credential</strong>
            The plaintext <code>lp_service_...</code> key is returned once.
            Place it directly in the deployment secret manager.
          </li>
        </ol>
        <CodeBlock
          language="text"
          code={`Create project "acme", add its "production" environment,
register service "api", and create a production service credential
labeled "Acme API production".`}
        />

        <h2 id="start-agent">3. Start one runtime agent</h2>
        <p>
          Configure the same project, environment, service, credential, and
          deployed commit in the application. The language guides contain exact
          startup code.
        </p>
        <CodeBlock code={commonRuntimeEnv} language="dotenv" />
        <p>
          Deploy the agent with the application. The application does not need
          to run on GCP; it only needs outbound HTTPS access to{" "}
          <code>liveprobe.tryastrea.tech</code>.
        </p>

        <h2 id="verify">4. Verify the connection</h2>
        <p>Run these read-only tools before placing a probe:</p>
        <CodeBlock
          language="text"
          code={`Ping the LiveProbe broker. In project acme and environment
production, list online services and show the safety overview.
Do not create a probe yet.`}
        />
        <p>
          <code>list_services</code> should show the service ID, SDK, deployed
          commit, latest heartbeat, capabilities, and online state. An empty
          list means the agent has not successfully heartbeated in the selected
          project and environment.
        </p>
      </>
    ),
  },
  {
    slug: "architecture",
    title: "How LiveProbe works",
    section: "Get started",
    description:
      "Understand the control plane, runtime data path, tenancy boundary, and what a probe can and cannot do.",
    headings: [
      { id: "request-path", label: "Request path" },
      { id: "resource-model", label: "Resource model" },
      { id: "runtime-boundary", label: "Runtime boundary" },
      { id: "data-lifecycle", label: "Data lifecycle" },
    ],
    content: (
      <>
        <h2 id="request-path">Request path</h2>
        <div className="architecture" aria-label="LiveProbe request path">
          <div className="architecture-node">
            <strong>AI client</strong>
            <span>Cursor or MCP host</span>
          </div>
          <div className="architecture-arrow">→</div>
          <div className="architecture-node">
            <strong>Broker + MCP</strong>
            <span>Auth, probes, routing</span>
          </div>
          <div className="architecture-arrow">↔</div>
          <div className="architecture-node">
            <strong>Runtime agent</strong>
            <span>Node, Python, or JVM</span>
          </div>
        </div>
        <p>
          Human users authenticate to the hosted MCP endpoint with Clerk. The
          broker resolves their active organization and applies tenant,
          project, and environment scope. Runtime agents use separately
          revocable service credentials and poll the broker for probe
          definitions.
        </p>
        <p>
          The MCP process never opens a direct connection to an application
          process. Agents initiate all broker communication over outbound
          HTTPS, then return sanitized events.
        </p>

        <h2 id="resource-model">Resource model</h2>
        <Table
          headers={["Resource", "Meaning", "Example"]}
          rows={[
            [
              "Organization",
              "Clerk workspace and hard tenant boundary",
              "Astrea Engineering",
            ],
            [
              "Project",
              "Repository or application identity",
              <code key="p">acme</code>,
            ],
            [
              "Environment",
              "Independent deployment scope",
              <code key="e">production</code>,
            ],
            [
              "Service",
              "Independently deployed process identity",
              <code key="s">api</code>,
            ],
          ]}
        />
        <p>
          A service is registered once in a project and can run in multiple
          environments. Credentials, heartbeats, probes, evidence, source maps,
          safety state, and audit events are routed by project and environment.
        </p>

        <h2 id="runtime-boundary">Runtime boundary</h2>
        <p>
          LiveProbe is read-only by design. Probe expressions operate on
          captured values using a broker-compiled bounded AST. Calls,
          assignment, constructors, imports, reflection, dynamic property
          expressions, and prototype traversal are rejected.
        </p>
        <Callout title="No zero-overhead claim" warning>
          <p>
            Node inspector breakpoints and JVM JDI breakpoints may briefly pause
            an executing thread. Python monitoring callbacks execute inside the
            target process. Safety budgets bound LiveProbe activity but do not
            turn it into a no-overhead profiler.
          </p>
        </Callout>

        <h2 id="data-lifecycle">Data lifecycle</h2>
        <ul>
          <li>Agents poll probe definitions roughly once per second.</li>
          <li>Captured values are redacted and structurally bounded in-process.</li>
          <li>Counter and metric samples are pre-aggregated before transport.</li>
          <li>Each probe retains up to 500 events; oldest events expire first.</li>
          <li>Probe TTL and hit limits automatically stop instrumentation.</li>
          <li>Removing a probe uninstalls it on the next agent poll.</li>
        </ul>
      </>
    ),
  },
  {
    slug: "catalog-and-credentials",
    title: "Projects, environments, and credentials",
    section: "Get started",
    description:
      "Model repositories and deployments, issue least-privilege runtime keys, rotate them, and archive unused identities.",
    headings: [
      { id: "choose-identifiers", label: "Choose identifiers" },
      { id: "provision", label: "Provision a service" },
      { id: "credential-storage", label: "Store credentials" },
      { id: "rotation", label: "Rotate and revoke" },
      { id: "archive", label: "Archive resources" },
    ],
    content: (
      <>
        <h2 id="choose-identifiers">Choose stable identifiers</h2>
        <p>
          Use one project ID per repository or cohesive application, one
          environment ID per deployment stage, and one service ID per
          independently deployed process. IDs should be lowercase and stable
          across deploys.
        </p>
        <Table
          headers={["Repository", "Project", "Environment", "Services"]}
          rows={[
            [
              "Acme Inc",
              <code key="1">acme</code>,
              <code key="2">production</code>,
              <span key="3">
                <code>api</code>, <code>worker</code>
              </span>,
            ],
            [
              "Astrea AI",
              <code key="4">astrea-ai</code>,
              <code key="5">staging</code>,
              <span key="6">
                <code>backend</code>
              </span>,
            ],
          ]}
        />

        <h2 id="provision">Provision a service</h2>
        <p>
          Resource creation is available through MCP. Tenant IDs are never
          accepted from tool input; the authenticated Clerk organization
          supplies the tenant boundary.
        </p>
        <CodeBlock
          language="text"
          code={`1. create_project(project_id="acme", display_name="Acme Inc")
2. create_environment(project_id="acme",
   environment_id="production", display_name="Production")
3. register_service(project_id="acme",
   service_id="api", display_name="API")
4. create_service_credential(project_id="acme",
   environment_id="production", service_id="api",
   label="API production July 2026")`}
        />

        <h2 id="credential-storage">Store the returned credential</h2>
        <p>
          The create response returns an <code>lp_service_...</code> API key
          exactly once. LiveProbe stores only its SHA-256 hash. Put the
          plaintext key in the target deployment&apos;s secret manager and
          expose it to the process as <code>LIVEPROBE_API_KEY</code>.
        </p>
        <Callout title="A credential is not a human API key">
          <p>
            A service credential can only poll, ingest, and upload source maps
            for its exact organization, project, environment, and service. It
            cannot list other services or manage probes.
          </p>
        </Callout>

        <h2 id="rotation">Rotate and revoke</h2>
        <ol>
          <li>Create a second credential with a dated label.</li>
          <li>Update the deployment secret and roll out the application.</li>
          <li>Confirm the service is heartbeating with the new key.</li>
          <li>
            Use <code>list_service_credentials</code> to locate the old
            credential ID.
          </li>
          <li>Revoke the old credential.</li>
        </ol>
        <p>
          Revocation takes effect on the next broker request. A revoked key
          receives HTTP 401 and cannot be recovered.
        </p>

        <h2 id="archive">Archive unused resources</h2>
        <p>
          Archiving a service revokes its credentials across every environment.
          Archiving an environment or project revokes all affected active
          credentials. Diagnostic and audit history is retained, and recreating
          the same ID restores the catalog identity.
        </p>
      </>
    ),
  },
  {
    slug: "mcp-setup",
    title: "Connect MCP clients",
    section: "MCP",
    description:
      "Use Clerk OAuth for the hosted server or the npm stdio package for local and break-glass operation.",
    headings: [
      { id: "hosted", label: "Hosted OAuth setup" },
      { id: "cursor", label: "Cursor workflow" },
      { id: "stdio", label: "Local stdio fallback" },
      { id: "auth-errors", label: "Authentication errors" },
    ],
    content: (
      <>
        <h2 id="hosted">Hosted OAuth setup</h2>
        <p>
          The production MCP endpoint uses Streamable HTTP and Clerk OAuth. Add
          this configuration:
        </p>
        <CodeBlock code={hostedMcpConfig} language="json" />
        <p>
          Select Login in the MCP client, authenticate in the browser, and
          choose an active Clerk organization. The client stores and refreshes
          the OAuth token. LiveProbe does not ask users to copy a human API key.
        </p>

        <h2 id="cursor">Cursor workflow</h2>
        <ol>
          <li>Open Cursor settings and add the MCP server configuration.</li>
          <li>Refresh MCP servers and complete the browser login.</li>
          <li>
            Ask Cursor to run <code>ping_broker</code>.
          </li>
          <li>
            Select a project and environment, then run{" "}
            <code>list_services</code>.
          </li>
          <li>
            Create or inspect catalog resources before issuing a runtime
            credential.
          </li>
        </ol>

        <h2 id="stdio">Local stdio fallback</h2>
        <p>
          The npm package is intended for local development and the shared-key
          break-glass path. It requires Node.js 20+.
        </p>
        <CodeBlock
          language="shell"
          code={`LIVEPROBE_API_KEY="<operator-key>" \\
npx -y @doomslayer2945/liveprobe-mcp@0.4.0 \\
  --broker-url https://liveprobe.tryastrea.tech`}
        />
        <CodeBlock
          language="json"
          code={`{
  "mcpServers": {
    "liveprobe": {
      "command": "npx",
      "args": [
        "-y",
        "@doomslayer2945/liveprobe-mcp@0.4.0",
        "--broker-url",
        "https://liveprobe.tryastrea.tech"
      ],
      "env": {
        "LIVEPROBE_API_KEY": "<operator-key>"
      }
    }
  }
}`}
        />

        <h2 id="auth-errors">Authentication errors</h2>
        <Table
          headers={["Error", "Meaning", "Action"]}
          rows={[
            [
              <code key="1">unauthorized</code>,
              "Missing, expired, invalid, or revoked token",
              "Reconnect hosted OAuth or replace the local bearer key",
            ],
            [
              <code key="2">organization_required</code>,
              "Clerk session has no active workspace",
              "Select the invited Clerk organization and reconnect",
            ],
            [
              <code key="3">clerk_session_pending</code>,
              "Organization enrollment is incomplete",
              "Complete the pending workspace enrollment",
            ],
            [
              <code key="4">forbidden</code>,
              "The identity cannot perform that operation",
              "Confirm workspace membership and operation scope",
            ],
            [
              <code key="5">scope_mismatch</code>,
              "A service key targeted another scope",
              "Use the project/environment used when issuing the key",
            ],
          ]}
        />
      </>
    ),
  },
  {
    slug: "tools",
    title: "MCP tool reference",
    section: "MCP",
    description:
      "Reference for all 23 catalog, credential, diagnostic, probe, safety, and audit tools.",
    headings: [
      { id: "diagnostic", label: "Diagnostic tools" },
      { id: "catalog", label: "Catalog tools" },
      { id: "credentials", label: "Credential tools" },
      { id: "probes", label: "Probe tools" },
      { id: "scope", label: "Scope and approvals" },
    ],
    content: (
      <>
        <h2 id="diagnostic">Diagnostic tools</h2>
        <div className="tool-list">
          {[
            ["ping_broker", "Check authenticated broker connectivity."],
            [
              "list_services",
              "List service heartbeats, SDKs, commits, capabilities, online state, and caveats.",
            ],
            [
              "get_safety_overview",
              "Return per-service safety state, enforced limits, reason codes, and probe counts.",
            ],
            [
              "list_audit_events",
              "Read tenant-scoped control events without bearer secrets or captured values.",
            ],
          ].map(([name, description]) => (
            <div className="tool-item" key={name}>
              <code>{name}</code>
              <p>{description}</p>
            </div>
          ))}
        </div>

        <h2 id="catalog">Catalog tools</h2>
        <div className="tool-list">
          {[
            ["list_projects", "List active or archived projects."],
            ["create_project", "Create or restore a project identity."],
            [
              "archive_project",
              "Archive a project and revoke affected active credentials.",
            ],
            [
              "list_environments",
              "List deployment environments in a project.",
            ],
            [
              "create_environment",
              "Create or restore a project environment.",
            ],
            [
              "archive_environment",
              "Archive an environment and revoke its active credentials.",
            ],
            [
              "list_registered_services",
              "List project-level service identities.",
            ],
            [
              "register_service",
              "Register or restore a service identity in a project.",
            ],
            [
              "archive_service",
              "Archive a service and revoke its credentials in all environments.",
            ],
          ].map(([name, description]) => (
            <div className="tool-item" key={name}>
              <code>{name}</code>
              <p>{description}</p>
            </div>
          ))}
        </div>

        <h2 id="credentials">Credential tools</h2>
        <div className="tool-list">
          {[
            [
              "create_service_credential",
              "Issue an environment-scoped runtime key and return plaintext once.",
            ],
            [
              "list_service_credentials",
              "List credential IDs, labels, prefixes, dates, and revocation state.",
            ],
            [
              "revoke_service_credential",
              "Immediately revoke one runtime credential.",
            ],
          ].map(([name, description]) => (
            <div className="tool-item" key={name}>
              <code>{name}</code>
              <p>{description}</p>
            </div>
          ))}
        </div>

        <h2 id="probes">Probe tools</h2>
        <div className="tool-list">
          {[
            [
              "set_snapshot_probe",
              "Capture bounded locals, paths, expressions, stack locations, and optional per-frame locals.",
            ],
            [
              "set_log_probe",
              "Emit temporary debug, info, warn, or error telemetry with safe placeholders.",
            ],
            [
              "set_counter_probe",
              "Count source-line executions with runtime pre-aggregation.",
            ],
            [
              "set_metric_probe",
              "Aggregate count, sum, min, max, and last for a numeric path or expression.",
            ],
            [
              "list_probes",
              "Inspect probe definitions and latest runtime status.",
            ],
            [
              "get_probe_data",
              "Read retained evidence or long-poll up to 30 seconds.",
            ],
            [
              "remove_probe",
              "Delete a probe and uninstall it on the next agent poll.",
            ],
          ].map(([name, description]) => (
            <div className="tool-item" key={name}>
              <code>{name}</code>
              <p>{description}</p>
            </div>
          ))}
        </div>

        <h2 id="scope">Scope and approvals</h2>
        <p>
          Operational tools accept <code>project_id</code> and{" "}
          <code>environment_id</code>. Probe setters also require the target{" "}
          <code>service_id</code>, source <code>file</code>, one-based{" "}
          <code>line</code>, and user-supplied deployed{" "}
          <code>commit_hash</code>.
        </p>
        <p>
          Archive, revoke, and remove operations are marked destructive. Probe
          setters alter diagnostic instrumentation but are not marked
          destructive because they do not intentionally mutate application
          variables.
        </p>
      </>
    ),
  },
  {
    slug: "probe-workflow",
    title: "Run a probe investigation",
    section: "MCP",
    description:
      "Select the exact deployment, choose the lowest-cost probe, collect bounded evidence, and clean up.",
    headings: [
      { id: "select-target", label: "Select the target" },
      { id: "choose-probe", label: "Choose a probe type" },
      { id: "commit", label: "Confirm the commit" },
      { id: "collect", label: "Collect evidence" },
      { id: "cleanup", label: "Clean up" },
    ],
    content: (
      <>
        <h2 id="select-target">Select the target deployment</h2>
        <p>
          Run <code>list_services</code> with the project and environment. Use
          the exact reported service ID, confirm it is online, and inspect its
          latest safety state and capability list.
        </p>

        <h2 id="choose-probe">Choose the lowest-cost probe</h2>
        <Table
          headers={["Question", "Probe"]}
          rows={[
            ["What values exist at this line?", <code key="1">snapshot</code>],
            ["Did this line execute?", <code key="2">counter</code>],
            [
              "How does a numeric value change?",
              <code key="3">metric</code>,
            ],
            [
              "What diagnostic message should be emitted?",
              <code key="4">log</code>,
            ],
          ]}
        />
        <p>
          Prefer counters and metrics on hot paths because agents pre-aggregate
          them. Start snapshots with a one-hit limit and a narrow watch list.
        </p>

        <h2 id="commit">Confirm the deployed commit</h2>
        <p>
          All set-probe MCP tools require <code>commit_hash</code>. Confirm it
          against the service-reported <code>commitSha</code>, then inspect
          source at that exact revision before choosing an executable line.
        </p>
        <CodeBlock
          language="shell"
          code={`git cat-file -e "<DEPLOYED_COMMIT>^{commit}"
git show "<DEPLOYED_COMMIT>:path/to/source-file"`}
        />
        <Callout title="Commit metadata is an honesty signal" warning>
          <p>
            Neither the MCP server nor the runtime cryptographically proves
            that loaded code matches the Git revision. A mismatch warning is a
            strong reason to stop and verify the deployment.
          </p>
        </Callout>

        <h2 id="collect">Collect bounded evidence</h2>
        <p>
          Create the probe with a short TTL and explicit hit limit. Use{" "}
          <code>get_probe_data</code> with <code>wait_seconds</code> up to 30
          rather than repeatedly polling. Review redaction and truncation
          markers when interpreting snapshots.
        </p>

        <h2 id="cleanup">Clean up</h2>
        <p>
          Remove the probe as soon as the question is answered. If no evidence
          arrives, inspect <code>list_probes</code> for{" "}
          <code>line-not-found</code>, <code>suspended</code>,{" "}
          <code>expired</code>, or <code>hit-limit-reached</code> state before
          creating another probe.
        </p>
      </>
    ),
  },
  {
    slug: "python",
    title: "Python SDK",
    section: "Runtime SDKs",
    description:
      "Install the Python 3.12+ sys.monitoring agent and attach it to your application lifecycle.",
    headings: [
      { id: "install", label: "Install" },
      { id: "configure", label: "Configure" },
      { id: "lifecycle", label: "Application lifecycle" },
      { id: "paths", label: "Source paths" },
      { id: "behavior", label: "Runtime behavior" },
    ],
    content: (
      <>
        <h2 id="install">Install</h2>
        <p>
          Python 3.12 or newer is required because the agent uses PEP 669{" "}
          <code>sys.monitoring</code>.
        </p>
        <CodeBlock
          language="shell"
          code="python -m pip install liveprobe==0.3.0"
        />

        <h2 id="configure">Configure</h2>
        <CodeBlock code={commonRuntimeEnv} language="dotenv" />
        <p>
          Keyword arguments override environment variables. Use the key issued
          for this exact project, environment, and service.
        </p>

        <h2 id="lifecycle">Application lifecycle</h2>
        <CodeBlock
          language="python"
          code={`import os
import liveprobe

agent = liveprobe.start(
    service_id=os.environ["LIVEPROBE_SERVICE_ID"],
    broker_url=os.environ["LIVEPROBE_BROKER_URL"],
    api_key=os.environ.get("LIVEPROBE_API_KEY"),
    commit_sha=os.environ.get("LIVEPROBE_COMMIT_SHA"),
    project_id=os.environ.get("LIVEPROBE_PROJECT_ID"),
    environment=os.environ.get("LIVEPROBE_ENVIRONMENT"),
)

# Call from the framework's existing graceful shutdown path.
liveprobe.stop()`}
        />
        <p>
          Start one process-wide agent after application initialization. In
          multiprocess deployments, each process starts its own agent instance
          and reports a distinct agent ID.
        </p>

        <h2 id="paths">Source paths</h2>
        <p>
          Python does not use source maps. A probe file must match a
          runtime-known <code>.py</code> path or an unambiguous suffix of that
          path. Deploy the same source layout used to run the application.
        </p>

        <h2 id="behavior">Runtime behavior</h2>
        <ul>
          <li>Conditions, watches, logs, and metrics support safe expressions.</li>
          <li>Log events support debug, info, warn, and error severity.</li>
          <li>Snapshots can capture bounded locals for selected stack frames.</li>
          <li>
            Safety reason codes include <code>pause_budget</code>,{" "}
            <code>instrumentation_failure</code>, and{" "}
            <code>agent_worker_failure</code>.
          </li>
          <li>
            Broker-rejected invalid events are dropped instead of permanently
            blocking later queued events.
          </li>
        </ul>
      </>
    ),
  },
  {
    slug: "node",
    title: "Node.js SDK",
    section: "Runtime SDKs",
    description:
      "Install the Node.js agent, attach lifecycle hooks, and upload external source maps for original TypeScript locations.",
    headings: [
      { id: "install", label: "Install" },
      { id: "start", label: "Start and stop" },
      { id: "source-map-config", label: "Source map configuration" },
      { id: "safety-config", label: "Safety configuration" },
    ],
    content: (
      <>
        <h2 id="install">Install</h2>
        <CodeBlock
          language="shell"
          code="npm install @doomslayer2945/liveprobe-node@0.3.0"
        />

        <h2 id="start">Start and stop</h2>
        <CodeBlock
          language="typescript"
          code={`import { LiveProbe } from "@doomslayer2945/liveprobe-node";

const agent = await LiveProbe.start({
  serviceId: process.env.LIVEPROBE_SERVICE_ID!,
  brokerUrl: process.env.LIVEPROBE_BROKER_URL!,
  apiKey: process.env.LIVEPROBE_API_KEY,
  commitSha: process.env.LIVEPROBE_COMMIT_SHA ?? process.env.GIT_COMMIT,
  projectId: process.env.LIVEPROBE_PROJECT_ID,
  environment: process.env.LIVEPROBE_ENVIRONMENT,
  sourceMapDir: process.env.LIVEPROBE_SOURCE_MAP_DIR,
  distLocation: process.env.LIVEPROBE_DIST_LOCATION ?? "dist",
  appRoot: process.env.LIVEPROBE_APP_ROOT,
});

process.once("SIGTERM", () => void agent.stop());`}
        />

        <h2 id="source-map-config">Source map configuration</h2>
        <p>
          Emit external <code>.js.map</code> files and deploy them beside the
          generated JavaScript. One agent uploads maps for each service and
          commit; embedded <code>sourcesContent</code> is stripped before
          transport. The broker resolves original source lines to generated V8
          locations.
        </p>
        <CodeBlock
          language="json"
          code={`{
  "compilerOptions": {
    "sourceMap": true,
    "inlineSourceMap": false
  }
}`}
        />
        <CodeBlock
          language="dotenv"
          code={`LIVEPROBE_SOURCE_MAP_DIR=/app/dist
LIVEPROBE_DIST_LOCATION=dist
LIVEPROBE_APP_ROOT=services/payments`}
        />
        <p>
          <code>LIVEPROBE_APP_ROOT</code> is only needed when uploaded source
          paths must be prefixed with a monorepo subdirectory.
        </p>

        <h2 id="safety-config">Safety configuration</h2>
        <p>
          Node enforces probe hit rate, outbound telemetry bandwidth, buffered
          event bytes, event-loop lag, and cooldown. See the safety reference
          for defaults and reason-code semantics.
        </p>
      </>
    ),
  },
  {
    slug: "jvm",
    title: "JVM bridge",
    section: "Runtime SDKs",
    description:
      "Attach the Java 17+ JDI sidecar to a privately exposed JDWP endpoint with full debug metadata.",
    headings: [
      { id: "artifact", label: "Install the artifact" },
      { id: "target", label: "Prepare the target JVM" },
      { id: "bridge", label: "Run the bridge" },
      { id: "limitations", label: "Current limitations" },
    ],
    content: (
      <>
        <h2 id="artifact">Install the artifact</h2>
        <p>
          The Maven coordinates are{" "}
          <code>io.liveprobe:liveprobe-bridge:0.3.0</code>. The pilot publishes
          to GitHub Packages, so Maven needs a GitHub token with{" "}
          <code>read:packages</code> and repository access.
        </p>
        <CodeBlock
          language="shell"
          code={`gh auth refresh --scopes read:packages
export GITHUB_ACTOR="$(gh api user --jq .login)"
export GITHUB_TOKEN="$(gh auth token)"

mvn dependency:get \\
  -Dartifact=io.liveprobe:liveprobe-bridge:0.3.0 \\
  -DremoteRepositories=github::default::https://maven.pkg.github.com/mohammed2945/LiveProbe`}
        />

        <h2 id="target">Prepare the target JVM</h2>
        <p>
          Compile with <code>javac -g</code> so class files include line-number
          and local-variable tables. Start JDWP on loopback or a private
          authenticated network boundary:
        </p>
        <CodeBlock
          language="shell"
          code={`java \\
  -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:5005 \\
  -jar application.jar`}
        />
        <Callout title="Never expose JDWP publicly" warning>
          <p>
            JDWP is a powerful debugging interface. Keep it on loopback, a
            sidecar network, or another private boundary that only the bridge
            can reach.
          </p>
        </Callout>

        <h2 id="bridge">Run the bridge</h2>
        <CodeBlock
          language="shell"
          code={`export LIVEPROBE_API_KEY="lp_service_<secret>"
export LIVEPROBE_PROJECT_ID="inventory"
export LIVEPROBE_ENVIRONMENT="production"

java --add-modules jdk.jdi \\
  -jar "$HOME/.m2/repository/io/liveprobe/liveprobe-bridge/0.3.0/liveprobe-bridge-0.3.0.jar" \\
  --service inventory-service \\
  --attach 127.0.0.1:5005 \\
  --broker https://liveprobe.tryastrea.tech \\
  --commit "$LIVEPROBE_COMMIT_SHA"`}
        />

        <h2 id="limitations">Current limitations</h2>
        <p>
          The JVM integration is a JDI sidecar, not a full{" "}
          <code>-javaagent</code>. Source files use suffix matching and require
          class debug metadata. JDI breakpoint requests may briefly suspend the
          executing thread. The bridge reports <code>rate_limited</code> while
          its breakpoint requests are suspended by the hit-rate safeguard.
        </p>
      </>
    ),
  },
  {
    slug: "rust",
    title: "Rust",
    section: "Runtime SDKs",
    description:
      "Attach eBPF uprobes to a compiled Rust service on Linux x86-64. No crate to add, no rebuild against a LiveProbe library.",
    headings: [
      { id: "how-it-works", label: "How it works" },
      { id: "debug-info", label: "Debug info you need" },
      { id: "setup", label: "Setup" },
      { id: "troubleshooting", label: "Troubleshooting" },
    ],
    content: (
      <>
        <LanguageSwitch current="rust" />
        <NativeHowItWorks />
        <NativeDebugInfo />
        <h2 id="setup">Setup</h2>
        <p>
          Linux x86-64 only, and about ten minutes on a fresh host. Every step
          you need is below.
        </p>
        <NativeSetupPath
          language="rust"
          buildStep={
            <>
              <p>Keep debug info in your release profile:</p>
              <CodeBlock
                language="toml"
                code={`# Cargo.toml
[profile.release]
debug = 2
strip = false`}
              />
              <CodeBlock
                language="shell"
                code={`cargo build --release
readelf --notes target/release/my-service | grep 'Build ID:'`}
              />
              <p>
                Cargo emits a build ID by default; <code>strip = false</code> is
                what keeps it and the DWARF in place.
              </p>
            </>
          }
        />
        <NativeTroubleshooting />
      </>
    ),
  },
  {
    slug: "cpp",
    title: "C++",
    section: "Runtime SDKs",
    description:
      "Attach eBPF uprobes to a compiled C++ service on Linux x86-64. No library to link, no rebuild against a LiveProbe SDK.",
    headings: [
      { id: "how-it-works", label: "How it works" },
      { id: "debug-info", label: "Debug info you need" },
      { id: "setup", label: "Setup" },
      { id: "troubleshooting", label: "Troubleshooting" },
    ],
    content: (
      <>
        <LanguageSwitch current="cpp" />
        <NativeHowItWorks />
        <NativeDebugInfo />
        <h2 id="setup">Setup</h2>
        <p>
          Linux x86-64 only, and about ten minutes on a fresh host. Every step
          you need is below.
        </p>
        <NativeSetupPath
          language="cpp"
          buildStep={
            <>
              <p>
                Compile with <code>-g</code> and ask the linker for a build ID:
              </p>
              <CodeBlock
                language="shell"
                code={`g++ -std=c++20 -O2 -g -fno-omit-frame-pointer \\
  -Wl,--build-id=sha1 main.cpp -o my-service

readelf --notes my-service | grep 'Build ID:'`}
              />
              <p>
                <code>--build-id</code> is not always on by default, so pass it
                explicitly.
              </p>
            </>
          }
        />
        <NativeTroubleshooting />
      </>
    ),
  },
  {
    slug: "source-locations",
    title: "Source locations and maps",
    section: "Runtime SDKs",
    description:
      "Choose source paths and executable lines that each runtime can resolve, including TypeScript source-map handling.",
    headings: [
      { id: "node-maps", label: "Node source maps" },
      { id: "python-paths", label: "Python paths" },
      { id: "jvm-metadata", label: "JVM metadata" },
      { id: "line-not-found", label: "Line not found" },
    ],
    content: (
      <>
        <h2 id="node-maps">Node source maps</h2>
        <p>
          Node agents scan <code>LIVEPROBE_SOURCE_MAP_DIR</code>, excluding
          hidden directories and <code>node_modules</code>. They upload Source
          Map v3 files once per service commit. The broker, not the agent,
          decodes mappings and returns generated script, line, and column
          coordinates.
        </p>
        <ul>
          <li>Deploy external maps with the generated JavaScript.</li>
          <li>Keep source paths stable between build and deployment.</li>
          <li>Set the generated prefix with <code>LIVEPROBE_DIST_LOCATION</code>.</li>
          <li>Use <code>LIVEPROBE_APP_ROOT</code> for monorepo subdirectories.</li>
        </ul>

        <h2 id="python-paths">Python paths</h2>
        <p>
          Probe files must be full runtime-known paths or unambiguous suffixes.
          There is no Python map loader. Prefer repository-relative suffixes
          such as <code>app/payments.py</code> instead of machine-specific
          absolute paths.
        </p>

        <h2 id="jvm-metadata">JVM metadata</h2>
        <p>
          Java source resolution uses class-file <code>LineNumberTable</code>{" "}
          metadata. Local variables and per-frame locals additionally require{" "}
          <code>LocalVariableTable</code>. Compile production artifacts with
          suitable debug information.
        </p>

        <h2 id="line-not-found">Diagnose line-not-found</h2>
        <ol>
          <li>Confirm the probe uses an executable one-based source line.</li>
          <li>Confirm the probe commit matches the deployed service commit.</li>
          <li>Inspect the path reported by the runtime or build output.</li>
          <li>For Node, verify map upload and source-map completion.</li>
          <li>For JVM, inspect class debug metadata and bridge connectivity.</li>
        </ol>
      </>
    ),
  },
  {
    slug: "expressions",
    title: "Conditions, expressions, and stack locals",
    section: "Probe behavior",
    description:
      "Use bounded read-only expressions and optional per-frame locals without executing application source.",
    headings: [
      { id: "dot-paths", label: "Dot paths" },
      { id: "safe-expressions", label: "Safe expressions" },
      { id: "log-templates", label: "Log templates" },
      { id: "stack-locals", label: "Stack locals" },
      { id: "capabilities", label: "Capability checks" },
    ],
    content: (
      <>
        <h2 id="dot-paths">Dot paths</h2>
        <p>
          Dot paths read fixed object, dictionary, or sequence segments such as{" "}
          <code>user.tier</code> or <code>orders.0.total</code>. Conditions
          support <code>eq</code>, <code>ne</code>, <code>gt</code>,{" "}
          <code>gte</code>, <code>lt</code>, and <code>lte</code> without type
          coercion.
        </p>

        <h2 id="safe-expressions">Safe expressions</h2>
        <p>
          Conditions, snapshot watches, log placeholders, and metrics can use
          broker-compiled expressions. Supported operations include fixed
          reference reads, scalar literals, boolean operations, comparisons,
          and bounded arithmetic.
        </p>
        <CodeBlock
          language="text"
          code={`order.total > 100 and user.tier == "free"
items.0.price * quantity
not request.cached`}
        />
        <p>
          Calls, assignment, constructors, imports, reflection, optional
          chaining, dynamic property expressions, and prototype segments are
          excluded. Types are strict. Division by zero, missing values,
          redacted references, unsafe integers, and non-finite values produce a
          structured evaluation error.
        </p>

        <h2 id="log-templates">Log templates and levels</h2>
        <p>
          Log probes support <code>debug</code>, <code>info</code>,{" "}
          <code>warn</code>, and <code>error</code>. Placeholders can be simple
          dot paths or safe expressions:
        </p>
        <CodeBlock
          language="text"
          code={'order=${order.id} total=${order.subtotal + order.tax}'}
        />
        <p>
          These are LiveProbe telemetry events. They do not enter the
          application&apos;s logging framework or invoke its logger.
        </p>

        <h2 id="stack-locals">Per-frame stack locals</h2>
        <p>
          Snapshot probes can set <code>include_stack_locals=true</code> and a{" "}
          <code>stack_frame_limit</code> from 1 to 8. Each selected frame uses
          the normal serializer, redaction, depth, property, array, and string
          limits. Frames without available debug metadata remain visible but
          may have no variables.
        </p>

        <h2 id="capabilities">Capability checks</h2>
        <p>
          Agents advertise <code>expression-ast-v1</code>,{" "}
          <code>frame-locals-v1</code>, <code>log-levels-v1</code>, and{" "}
          <code>safety-report-v1</code>. The broker rejects a probe requiring a
          capability the active service replicas have not all reported.
        </p>
      </>
    ),
  },
  {
    slug: "redaction",
    title: "Redaction and capture limits",
    section: "Probe behavior",
    description:
      "Understand in-process sanitization, structural bounds, exact-value redaction, and retained evidence limits.",
    headings: [
      { id: "in-process", label: "In-process sanitization" },
      { id: "defaults", label: "Default limits" },
      { id: "redaction-rules", label: "Redaction rules" },
      { id: "retention", label: "Evidence retention" },
    ],
    content: (
      <>
        <h2 id="in-process">In-process sanitization</h2>
        <p>
          Raw captured values are traversed and sanitized inside the target
          runtime. Only the serialized tree crosses the process or network
          boundary. Circular values, unsupported types, and values beyond
          structural limits become explicit truncation markers.
        </p>

        <h2 id="defaults">Default structural limits</h2>
        <Table
          headers={["Limit", "Default"]}
          rows={[
            ["Object depth", "3"],
            ["Array items", "3"],
            ["Object properties", "50"],
            ["String characters", "1,024"],
            ["Stack frames", "8"],
            ["Retained events per probe", "500"],
          ]}
        />

        <h2 id="redaction-rules">Redaction rules</h2>
        <p>
          Default key matching is case-insensitive and includes password,
          secret, token, authorization, cookie, key, signature, SSN, and credit
          card patterns. Runtime configuration can extend key patterns and add
          exact, case-sensitive string values.
        </p>
        <Callout title="Review domain-specific secrets" warning>
          <p>
            Generic rules cannot recognize every business identifier or
            regulated value. Add deployment-specific redaction values and keep
            watch paths narrow.
          </p>
        </Callout>

        <h2 id="retention">Evidence retention</h2>
        <p>
          Probe events are stored in a 500-event ring per probe. New events
          discard the oldest. Removing a probe stops future collection but does
          not imply immediate destruction of retained audit or diagnostic
          history.
        </p>
      </>
    ),
  },
  {
    slug: "safety",
    title: "Runtime safety",
    section: "Probe behavior",
    description:
      "Interpret normalized safety states, enforced limits, runtime-specific reason codes, and cooldown behavior.",
    headings: [
      { id: "overview", label: "Safety overview" },
      { id: "limits", label: "Canonical limits" },
      { id: "reason-codes", label: "Reason codes" },
      { id: "semantics", label: "Runtime semantics" },
    ],
    content: (
      <>
        <h2 id="overview">Safety overview</h2>
        <p>
          <code>get_safety_overview</code> returns the broker-derived online
          state, latest agent state, raw detail, enforced limits, probe status
          counts, and caveats for each service. Green means the agent has not
          reported a LiveProbe safeguard trip. It is not a general application
          health signal.
        </p>

        <h2 id="limits">Canonical limits</h2>
        <Table
          headers={["Environment variable", "Default", "Runtimes"]}
          rows={[
            [
              <code key="1">LIVEPROBE_MAX_PROBE_HITS_PER_SECOND</code>,
              "10",
              "Node, Python, JVM",
            ],
            [
              <code key="2">LIVEPROBE_MAX_PROBE_PAUSE_MS_PER_SECOND</code>,
              "20 ms",
              "Python",
            ],
            [
              <code key="3">LIVEPROBE_MAX_TELEMETRY_BYTES_PER_SECOND</code>,
              "204,800",
              "Node, Python",
            ],
            [
              <code key="4">LIVEPROBE_MAX_BUFFERED_EVENT_BYTES</code>,
              "5 seconds of telemetry, minimum 64 KiB",
              "Node",
            ],
            [
              <code key="5">LIVEPROBE_MAX_EVENT_LOOP_LAG_MS</code>,
              "50 ms p95",
              "Node",
            ],
            [
              <code key="6">LIVEPROBE_SAFETY_COOLDOWN_MS</code>,
              "10,000 ms",
              "Node, Python",
            ],
          ]}
        />
        <p>
          Agents report only safeguards they actually enforce. An omitted limit
          means unsupported, not zero utilization.
        </p>

        <h2 id="reason-codes">Reason codes</h2>
        <Table
          headers={["Code", "Meaning"]}
          rows={[
            [
              <code key="1">event_loop_lag</code>,
              "Node event-loop p95 exceeded the configured threshold",
            ],
            [
              <code key="2">pause_budget</code>,
              "Python callbacks exceeded their per-second time budget",
            ],
            [
              <code key="3">rate_limited</code>,
              "JVM breakpoint requests were suspended by hit-rate protection",
            ],
            [
              <code key="4">instrumentation_failure</code>,
              "The runtime could not install or maintain instrumentation",
            ],
            [
              <code key="5">agent_worker_failure</code>,
              "An internal agent worker failed",
            ],
          ]}
        />

        <h2 id="semantics">Runtime semantics</h2>
        <p>
          A red state describes LiveProbe&apos;s own runtime activity. It does
          not measure CPU load, memory pressure, garbage collection, or overall
          service availability. Reduce probe rate, remove hot-path snapshots,
          and wait for cooldown before retrying.
        </p>
      </>
    ),
  },
  {
    slug: "security",
    title: "Authentication and security",
    section: "Security",
    description:
      "Review Clerk organization tenancy, service-key isolation, TLS, the break-glass path, and runtime security boundaries.",
    headings: [
      { id: "human-auth", label: "Human authentication" },
      { id: "agent-auth", label: "Agent authentication" },
      { id: "network", label: "Network boundary" },
      { id: "break-glass", label: "Break-glass access" },
      { id: "limitations", label: "Security limitations" },
    ],
    content: (
      <>
        <h2 id="human-auth">Human authentication</h2>
        <p>
          Hosted MCP users authenticate through Clerk OAuth. The active Clerk
          organization ID becomes the tenant boundary. Removed memberships fail
          closed, and sessions without an active organization cannot access
          tenant data.
        </p>
        <p>
          The pilot presents one practical user experience inside each
          organization, while the protocol retains admin, operator, and viewer
          permissions for future policy refinement.
        </p>

        <h2 id="agent-auth">Agent authentication</h2>
        <p>
          Runtime credentials are high-entropy bearer secrets scoped to one
          organization, project, environment, and service. PostgreSQL stores
          only their SHA-256 hashes. Plaintext is returned once when created and
          cannot be listed later.
        </p>

        <h2 id="network">Network boundary</h2>
        <p>
          Public traffic terminates TLS at the Google Cloud HTTPS load
          balancer. The VM origin accepts broker traffic only from Google load
          balancer and health-check ranges. Runtime agents need only outbound
          HTTPS access; no inbound connection to the client application is
          required.
        </p>

        <h2 id="break-glass">Break-glass access</h2>
        <p>
          A shared internal admin key remains available for local stdio and
          operator recovery. It is stored in Google Secret Manager and should
          not be distributed to ordinary users or embedded in application
          repositories.
        </p>

        <h2 id="limitations">Security limitations</h2>
        <ul>
          <li>Bearer credentials must be protected wherever they are injected.</li>
          <li>Redaction rules cannot identify every domain-specific secret.</li>
          <li>Commit SHAs are honesty metadata, not bytecode attestation.</li>
          <li>Database append-only audit controls are not cryptographic WORM.</li>
          <li>JDWP must never be exposed to the public network.</li>
        </ul>
      </>
    ),
  },
  {
    slug: "operations",
    title: "Production operations",
    section: "Operators",
    description:
      "Operate the hosted broker on GCP with regional Cloud SQL, Secret Manager, HTTPS, monitoring, backups, and controlled releases.",
    headings: [
      { id: "topology", label: "Production topology" },
      { id: "database", label: "Database" },
      { id: "secrets", label: "Secrets" },
      { id: "deploy", label: "Deploy" },
      { id: "monitoring", label: "Monitoring" },
    ],
    content: (
      <>
        <Callout title="Operator-only material">
          <p>
            Application teams do not need a database URL or GCP access. They
            receive a scoped service credential and the public broker URL.
          </p>
        </Callout>

        <h2 id="topology">Production topology</h2>
        <ul>
          <li>Google Cloud HTTPS load balancer with managed TLS certificate.</li>
          <li>Broker containers on a Compute Engine VM.</li>
          <li>Cloud SQL Auth Proxy between the broker and PostgreSQL.</li>
          <li>Clerk OAuth for hosted human MCP access.</li>
          <li>Google Secret Manager for broker and database credentials.</li>
        </ul>

        <h2 id="database">Database</h2>
        <p>
          Production uses PostgreSQL 16 in a regional Cloud SQL configuration
          spanning two zones. Automated backups and point-in-time recovery are
          enabled. The database stores resource catalog records, service
          credentials and hashes, service versions and heartbeats, probes,
          statuses, retained events, source maps, and audit events.
        </p>
        <p>
          Clients never receive <code>DATABASE_URL</code>. The broker is the
          only public data access boundary.
        </p>

        <h2 id="secrets">Secrets</h2>
        <p>
          Secret Manager contains the shared break-glass key ring, PostgreSQL
          password, and Clerk backend secret. Non-secret Clerk origins and the
          publishable key are deployment configuration.
        </p>

        <h2 id="deploy">Deploy</h2>
        <CodeBlock
          language="shell"
          code={`PROJECT_ID="<gcp-project>" \\
DATABASE_BACKEND=cloud-sql \\
CLOUD_SQL_AVAILABILITY_TYPE=regional \\
HTTPS_DOMAIN=liveprobe.tryastrea.tech \\
deploy/gcp/deploy.sh`}
        />
        <p>
          Deploy only a clean, tested Git revision. The script builds on the VM,
          waits for container health, and reports the exact deployed SHA.
          Preserve all Clerk production configuration when redeploying.
        </p>

        <h2 id="monitoring">Monitoring</h2>
        <p>
          Monitor broker readiness, load-balancer 5xx responses, VM and
          container health, Cloud SQL connectivity, storage, and backup age.
          Smoke tests should not intentionally generate 5xx responses because
          they create false incidents.
        </p>
      </>
    ),
  },
  {
    slug: "backup-and-recovery",
    title: "Backup and recovery",
    section: "Operators",
    description:
      "Create manual backups, verify regional availability and PITR, and run recovery drills without using client credentials.",
    headings: [
      { id: "backup", label: "Create a backup" },
      { id: "verify", label: "Verify protection" },
      { id: "drill", label: "Run a recovery drill" },
      { id: "fallback", label: "Local fallback" },
    ],
    content: (
      <>
        <h2 id="backup">Create a manual backup</h2>
        <CodeBlock
          language="shell"
          code={`PROJECT_ID="<gcp-project>" deploy/gcp/backup.sh`}
        />
        <p>
          With the Cloud SQL backend, this creates a managed on-demand backup.
          The script detects the deployed backend before choosing its backup
          path.
        </p>

        <h2 id="verify">Verify protection</h2>
        <p>Confirm all of the following before a production release:</p>
        <ul>
          <li>Cloud SQL state is runnable.</li>
          <li>Availability type is regional and a secondary zone is present.</li>
          <li>Automated backups are enabled.</li>
          <li>Point-in-time recovery is enabled.</li>
          <li>The broker readiness endpoint returns HTTP 200.</li>
        </ul>

        <h2 id="drill">Run a recovery drill</h2>
        <CodeBlock
          language="shell"
          code={`PROJECT_ID="<gcp-project>" deploy/gcp/recovery-drill.sh`}
        />
        <p>
          Recovery drills may take several minutes while Cloud SQL creates and
          verifies temporary resources. Keep the command attached until it
          reports success or failure, and verify temporary resources are
          cleaned up.
        </p>

        <h2 id="fallback">Local fallback</h2>
        <p>
          <code>LIVEPROBE_STATE_FILE</code> remains a local and development
          fallback when <code>DATABASE_URL</code> is unset. The resource
          catalog, self-service service credentials, and durable audit store
          require PostgreSQL and return an unavailable error on JSON fallback.
        </p>
      </>
    ),
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    section: "Reference",
    description:
      "Diagnose connection, authentication, empty service lists, source resolution, missing events, and safety suspension.",
    headings: [
      { id: "connectivity", label: "Connectivity" },
      { id: "empty-services", label: "Empty services" },
      { id: "probe-status", label: "Probe status" },
      { id: "runtime-specific", label: "Runtime-specific checks" },
    ],
    content: (
      <>
        <h2 id="connectivity">Connectivity and authentication</h2>
        <Table
          headers={["Symptom", "Check"]}
          rows={[
            [
              "MCP unauthorized",
              "Reconnect Clerk OAuth; for stdio, replace the operator key",
            ],
            [
              "Agent unauthorized",
              "Confirm the service key is active and belongs to the exact scope",
            ],
            [
              "Timeout",
              "Check DNS, outbound HTTPS, broker URL, and network egress policy",
            ],
            [
              "Health succeeds, ping fails",
              "The endpoint is reachable but the bearer credential is invalid",
            ],
          ]}
        />
        <CodeBlock
          language="shell"
          code={`curl --fail https://liveprobe.tryastrea.tech/healthz
curl --fail https://liveprobe.tryastrea.tech/readyz`}
        />

        <h2 id="empty-services">list_services returns an empty array</h2>
        <p>
          This is expected before any runtime agent has successfully
          heartbeated in the selected project and environment. Check that the
          application actually starts the SDK, the deployed commit is valid,
          and all scope values match the issued credential.
        </p>

        <h2 id="probe-status">Probe status</h2>
        <Table
          headers={["Status or detail", "Meaning"]}
          rows={[
            ["armed", "Installed and waiting for the line to execute"],
            ["line-not-found", "The runtime could not resolve the path and line"],
            ["suspended", "A runtime safety safeguard has paused the probe"],
            ["hit-limit-reached", "The configured hit limit completed"],
            ["expired", "The broker-enforced TTL elapsed"],
            ["error", "Inspect status detail and runtime logs"],
          ]}
        />

        <h2 id="runtime-specific">Runtime-specific checks</h2>
        <ul>
          <li>
            <strong>Node:</strong> deploy external maps and verify source map
            directory, generated prefix, and app-root prefix.
          </li>
          <li>
            <strong>Python:</strong> confirm Python 3.12+ and a matching runtime
            source-path suffix.
          </li>
          <li>
            <strong>JVM:</strong> compile with debug metadata, keep JDWP private,
            and verify bridge attachment.
          </li>
          <li>
            <strong>All runtimes:</strong> confirm project, environment, service,
            credential, and deployed commit all describe the same process.
          </li>
        </ul>
      </>
    ),
  },
  {
    slug: "environment-reference",
    title: "Environment variable reference",
    section: "Reference",
    description:
      "Canonical client runtime and operator configuration names for LiveProbe 0.3.0.",
    headings: [
      { id: "runtime", label: "All runtime agents" },
      { id: "node", label: "Node-specific" },
      { id: "safety", label: "Safety limits" },
      { id: "operator", label: "Broker operator" },
    ],
    content: (
      <>
        <h2 id="runtime">All runtime agents</h2>
        <Table
          headers={["Variable", "Purpose"]}
          rows={[
            [
              <code key="1">LIVEPROBE_API_KEY</code>,
              "Scoped service credential",
            ],
            [
              <code key="2">LIVEPROBE_COMMIT_SHA</code>,
              "Required deployed hexadecimal Git revision",
            ],
            [
              <code key="3">GIT_COMMIT</code>,
              "Fallback deployed revision",
            ],
            [
              <code key="4">LIVEPROBE_PROJECT_ID</code>,
              "Stable repository or application scope",
            ],
            [
              <code key="5">LIVEPROBE_ENVIRONMENT</code>,
              "Deployment environment scope",
            ],
          ]}
        />
        <p>
          Node and Python application code also receive the broker URL and
          service ID. The exact names may be passed as SDK options; this guide
          uses <code>LIVEPROBE_BROKER_URL</code> and{" "}
          <code>LIVEPROBE_SERVICE_ID</code> consistently in deployment
          configuration.
        </p>

        <h2 id="node">Node-specific variables</h2>
        <Table
          headers={["Variable", "Purpose"]}
          rows={[
            [
              <code key="1">LIVEPROBE_SOURCE_MAP_DIR</code>,
              "Directory scanned for external .js.map files",
            ],
            [
              <code key="2">LIVEPROBE_DIST_LOCATION</code>,
              "Generated output prefix; defaults to dist",
            ],
            [
              <code key="3">LIVEPROBE_APP_ROOT</code>,
              "Optional monorepo source-path prefix",
            ],
          ]}
        />

        <h2 id="safety">Safety variables</h2>
        <p>
          See <a href="/docs/safety">Runtime safety</a> for defaults and
          per-runtime support:
        </p>
        <CodeBlock
          language="dotenv"
          code={`LIVEPROBE_MAX_PROBE_HITS_PER_SECOND=10
LIVEPROBE_MAX_PROBE_PAUSE_MS_PER_SECOND=20
LIVEPROBE_MAX_TELEMETRY_BYTES_PER_SECOND=204800
LIVEPROBE_MAX_BUFFERED_EVENT_BYTES=1024000
LIVEPROBE_MAX_EVENT_LOOP_LAG_MS=50
LIVEPROBE_SAFETY_COOLDOWN_MS=10000`}
        />

        <h2 id="operator">Broker operator variables</h2>
        <Table
          headers={["Variable", "Purpose"]}
          rows={[
            [<code key="1">DATABASE_URL</code>, "PostgreSQL durable store"],
            [
              <code key="2">LIVEPROBE_DB_POOL_SIZE</code>,
              "Broker PostgreSQL pool size; default 10",
            ],
            [
              <code key="3">LIVEPROBE_STATE_FILE</code>,
              "Local/dev JSON fallback when DATABASE_URL is unset",
            ],
            [
              <code key="4">CLERK_SECRET_KEY</code>,
              "Clerk backend verification and membership resolution",
            ],
            [
              <code key="5">CLERK_PUBLISHABLE_KEY</code>,
              "OAuth metadata configuration",
            ],
            [
              <code key="6">CLERK_FRONTEND_API_URL</code>,
              "Clerk production authorization-server origin",
            ],
            [
              <code key="7">CLERK_AUTHORIZED_PARTIES</code>,
              "Allowed frontend origins for Clerk tokens",
            ],
            [
              <code key="8">LIVEPROBE_PUBLIC_URL</code>,
              "Public HTTPS origin used in OAuth metadata",
            ],
          ]}
        />
      </>
    ),
  },
  {
    slug: "protocol",
    title: "Protocol and compatibility",
    section: "Reference",
    description:
      "Versioning, capability negotiation, commit metadata, event contracts, and links to the canonical protocol.",
    headings: [
      { id: "version", label: "Protocol version" },
      { id: "capabilities", label: "Capability negotiation" },
      { id: "events", label: "Event types" },
      { id: "source", label: "Canonical source" },
    ],
    content: (
      <>
        <h2 id="version">Protocol version</h2>
        <p>
          LiveProbe 0.3.0 implements protocol v1. JSON fields use camelCase on
          HTTP and tool inputs use snake_case at the MCP boundary. Consumers
          ignore unknown response fields; producers do not emit undocumented
          v1 request fields.
        </p>

        <h2 id="capabilities">Capability negotiation</h2>
        <Table
          headers={["Capability", "Behavior"]}
          rows={[
            [
              <code key="1">log-levels-v1</code>,
              "Debug, info, warn, and error log telemetry",
            ],
            [
              <code key="2">expression-ast-v1</code>,
              "Broker-compiled safe expressions",
            ],
            [
              <code key="3">frame-locals-v1</code>,
              "Optional bounded variables for selected stack frames",
            ],
            [
              <code key="4">safety-report-v1</code>,
              "Normalized limits and reason codes",
            ],
          ]}
        />
        <p>
          For multiple active replicas, the broker exposes the intersection of
          capabilities reported within the 45-second activity window. This
          prevents a probe from depending on a feature missing from one replica.
        </p>

        <h2 id="events">Event types</h2>
        <p>
          Runtime agents emit snapshot, log, counter, metric, and status events.
          Heartbeats may contain no events. Successful ingest returns HTTP 202
          with the accepted count.
        </p>

        <h2 id="source">Canonical source</h2>
        <p>
          The repository&apos;s{" "}
          <a
            href="https://github.com/mohammed2945/LiveProbe/blob/main/spec/protocol.md"
            target="_blank"
            rel="noreferrer"
          >
            protocol specification
          </a>{" "}
          is the canonical broker, MCP, and runtime contract. Package READMEs
          provide language-specific startup examples.
        </p>
      </>
    ),
  },
];

export function getDoc(slug: string) {
  return docs.find((doc) => doc.slug === slug);
}
