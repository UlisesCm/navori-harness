import { describe, it, expect } from "vitest";
import { parseAsset } from "../parse-asset.ts";

const HTML_ASSET = `---
name: leader
description: Orquestador.
tools: Read, Bash
model: opus
---

# Title

Some managed content here.

<!-- navori:user-section -->
## User-defined

<!-- user: fill me -->
`;

const SHELL_ASSET = `---
name: qg-fast
description: ...
---

#!/usr/bin/env bash
set -euo pipefail
{{qualityGate.fast}}

# navori:user-section
# user: agregá checks
`;

describe("parseAsset — html", () => {
  it("extracts frontmatter, managed body and user template", () => {
    const p = parseAsset(HTML_ASSET, "html");
    expect(p.frontmatter.name).toBe("leader");
    expect(p.frontmatter.tools).toBe("Read, Bash");
    expect(p.managedBody).toContain("# Title");
    expect(p.managedBody).toContain("Some managed content");
    expect(p.managedBody).not.toContain("<!-- navori:user-section -->");
    expect(p.userTemplate).toContain("## User-defined");
    expect(p.userTemplate).toContain("<!-- user: fill me -->");
  });

  it("returns userTemplate null when sentinel absent", () => {
    const raw = `---\nname: x\n---\n\n# Body only\n`;
    const p = parseAsset(raw, "html");
    expect(p.userTemplate).toBeNull();
    expect(p.managedBody).toBe("# Body only");
  });

  it("allows assets without frontmatter (shell hooks with shebang first line)", () => {
    const raw = `#!/usr/bin/env bash\nset -euo pipefail\necho hi\n`;
    const p = parseAsset(raw, "shell");
    expect(p.frontmatter).toEqual({});
    expect(p.managedBody).toContain("#!/usr/bin/env bash");
    expect(p.userTemplate).toBeNull();
  });
});

describe("parseAsset — shell", () => {
  it("splits at a line-anchored shell sentinel", () => {
    const p = parseAsset(SHELL_ASSET, "shell");
    expect(p.frontmatter.name).toBe("qg-fast");
    expect(p.managedBody).toContain("#!/usr/bin/env bash");
    expect(p.managedBody).toContain("{{qualityGate.fast}}");
    expect(p.userTemplate).toMatch(/agregá checks/);
  });

  it("does NOT split on text that contains the sentinel string inline", () => {
    const raw = `---\nname: x\n---\n\necho "this is # navori:user-section inline"\n`;
    const p = parseAsset(raw, "shell");
    expect(p.userTemplate).toBeNull();
    expect(p.managedBody).toContain("# navori:user-section");
  });
});
