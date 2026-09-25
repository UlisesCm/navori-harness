# Skills security and quality references

Last reviewed: 2026-09-20. This is a provenance record, not a copy of a
standard or a default installation authorization.

## Closed skill inventory

| Skill set | Supported dependency/version | Official source | Trigger | Validation evidence |
|---|---|---|---|---|
| Core: `verify-before-done`, `debug-failure`, `review-diff`, `security-invariants`, `locate-code` | Harness CLI 0.10.1 assets; bump the row with each release | https://github.com/ulisescm/navori-harness | Their frontmatter description | Asset caps, roster and render tests |
| Workflow: `resolve-ticket`, `solution-design`, `spec-bootstrap`, `dominio`, `follow-up-prs` | Harness CLI 0.10.1 assets; bump the row with each release | https://github.com/ulisescm/navori-harness | Their frontmatter description | Asset caps, roster and render tests |
| `zod-validation` | Zod 4.4.3 | https://zod.dev | Trust-boundary validation | Locked package + snippet regression |
| `vitest` | Vitest 5.0.1 | https://vitest.dev | Vitest tests | Locked package + snippet regression |
| `citty` | Citty 0.1.6 | https://github.com/unjs/citty | Citty CLI changes | Locked declaration regression |
| `clack` | @clack/prompts 0.10.0 | https://clack.cc | Interactive CLI flows | Locked package + asset regression |

The previous 0.8.7 entry is the audit baseline; this table records the current
release's generated assets rather than preserving it as a supported version.

## External reference and vendor-skill evaluation

| Item | Canonical URL and immutable revision | Terms / permitted use | Permissions and privacy | Owner | Reversible pilot |
|---|---|---|---|---|---|
| OWASP ASVS | https://github.com/OWASP/ASVS/releases/tag/v5.0.0 — 5.0.0 | CC BY-SA 4.0; reference selected control ids, do not copy checklists | No tool access; standards are reference data | Security owner | Fixture-only mapping; no roster/config/hook change |
| NIST SSDF | https://csrc.nist.gov/pubs/sp/800/218/final — SP 800-218 rev. 1.1 | NIST public publication; cite and summarize locally | No tool access | Security owner | Fixture-only mapping; no roster/config/hook change |
| SLSA | https://slsa.dev/spec/v1.1/ — v1.1 | CC BY 4.0; cite provenance levels only | No tool access | Security owner | Fixture-only mapping; no roster/config/hook change |
| ISO/IEC 25010 | https://www.iso.org/standard/78176.html — 2023 edition | Copyright ISO; use as attribute model only, do not reproduce text/tables | No tool access | Architecture owner | Matrix fixture uses original criteria only |
| OpenAI security-best-practices | https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/security-best-practices/SKILL.md — commit `49f948faa9258a0c61caceaf225e179651397431` | Repository terms apply; evaluate before redistribution | Read-only fixture review; do not enable hooks/tools | Security owner | Not installed; no roster/config/hook change; rollback is no-op |
| OpenAI security-threat-model | https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/security-threat-model/SKILL.md — commit `49f948faa9258a0c61caceaf225e179651397431` | Repository terms apply; evaluate before redistribution | Read-only fixture review; do not enable hooks/tools | Security owner | Not installed; no roster/config/hook change; rollback is no-op |

Any future adoption requires explicit approval, a recorded permission/privacy
review, a bounded pilot with exit criteria, and removal of the added skill or
plugin on rollback. The default remains the two local thin skills.
