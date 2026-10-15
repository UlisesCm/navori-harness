import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

/** No supported outer-agent guard and separate controller browsing context are established. */
export function approvalSourceIsolationAvailable(): boolean {
  // Ceiling: publication stays pending; enable only after proving both host isolation boundaries.
  return false;
}

/** Self-contained host UI; credentials live only in the fragment and JS memory. */
export const APPROVAL_HTML = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Review PR publication</title>
<style>body{font:18px system-ui;margin:3rem auto;max-width:55rem;padding:0 1rem;color:#17212b;background:#fafafa}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:1rem;border:1px solid #ccd3da}button{font:inherit;padding:.7rem 1rem;margin:.5rem;cursor:pointer}button:focus-visible{outline:3px solid #2359bf}#accept{background:#17212b;color:white}#status{min-height:2rem}</style>
<h1>Review PR publication</h1><p>This decision applies once to the exact destination and bytes below.</p>
<pre id="scope" aria-label="Immutable publication scope"></pre><p id="status" role="status">Loading request…</p>
<button id="accept" disabled>Publish this PR</button><button id="decline" disabled>Decline</button>
<script>
(() => {
  let credential = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  const status = document.getElementById('status');
  const buttons = [document.getElementById('accept'), document.getElementById('decline')];
  const headers = () => ({Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json'});
  let challenge;
  const decide = async (decision) => {
    buttons.forEach(button => {button.disabled = true;});
    try {
      const result = await fetch('/decision', {method:'POST', headers:headers(), body:JSON.stringify({decision, csrf:challenge.csrf, identity:challenge.identity})});
      status.textContent = result.ok ? 'Decision recorded. This request cannot be used again.' : 'Request closed or invalid. Return to the host client.';
    } catch { status.textContent = 'Connection closed. Return to the host client; do not retry publication.'; }
    credential = ''; challenge = undefined;
  };
  buttons[0].onclick = () => decide('accept'); buttons[1].onclick = () => decide('decline');
  fetch('/request', {headers:headers()}).then(async response => {
    if (!response.ok) throw new Error('closed');
    challenge = await response.json();
    document.getElementById('scope').textContent = JSON.stringify(challenge.scope, null, 2);
    status.textContent = 'Review every field before deciding.';
    buttons.forEach(button => {button.disabled = false;});
  }).catch(() => {credential = ''; status.textContent = 'No authenticated outstanding request. Return to the host client.';});
})();
</script></html>`;

/** Restrictive policy permits only this fixed inline UI, without external assets. */
export function approvalContentSecurityPolicy(): string {
  const script = APPROVAL_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const style = APPROVAL_HTML.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  const hash = (value: string): string => createHash("sha256").update(value).digest("base64");
  return `default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(style)}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

/** Host-only bootstrap: fixed system launcher, no shell, output, env or persisted URL. */
export function launchApprovalBrowser(url: string): Promise<boolean> {
  if (!approvalSourceIsolationAvailable() || process.platform !== "darwin")
    return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/open", [url], { stdio: "ignore", env: {} });
    const timeout = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 5_000);
    child.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}
