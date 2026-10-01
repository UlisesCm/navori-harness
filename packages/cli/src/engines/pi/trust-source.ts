/** Fail-closed trust precondition embedded in the generated Pi extension. */
export const PI_TRUST_SOURCE = String.raw`
function assertTrustedPiParent(ctx: { isProjectTrusted?: () => boolean }): void {
  let trusted = false;
  try {
    trusted = ctx.isProjectTrusted?.() === true;
  } catch {
    // A missing or failing Pi trust API is not permission to run a child.
  }
  if (!trusted) throw new Error("Navori Pi subagent requires a trusted parent project");
}
`;
