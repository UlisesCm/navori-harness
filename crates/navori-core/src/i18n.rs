//! Strings of `packages/cli/src/lib/i18n.ts` emitted by native code, per locale. Only the entries
//! the ported commands print live here; each one is checked against the TS by the parity tests.

use crate::render::context::Lang;

/// `common.unknownConfigValues`.
#[must_use]
pub fn unknown_config_values(lang: Lang, list: &str) -> String {
    match lang {
        Lang::Es => format!(
            "navori: valores de config desconocidos ignorados (¿config de un navori más nuevo? actualiza el CLI): {list}"
        ),
        Lang::En => format!(
            "navori: unknown config values ignored (config from a newer navori? update the CLI): {list}"
        ),
    }
}

/// `common.unknownConfigKeys`.
#[must_use]
pub fn unknown_config_keys(lang: Lang, list: &str) -> String {
    match lang {
        Lang::Es => format!(
            "navori: claves de config desconocidas (no se rechazan para mantener compatibilidad futura): {list}"
        ),
        Lang::En => format!(
            "navori: unknown config keys (not rejected to preserve forward compatibility): {list}"
        ),
    }
}

/// `common.deadProgressKeys`.
#[must_use]
pub fn dead_progress_keys(lang: Lang, list: &str) -> String {
    match lang {
        Lang::Es => format!(
            "navori: claves obsoletas ignoradas en \"progress\" (puedes borrarlas del navori.config.json): {list}"
        ),
        Lang::En => format!(
            "navori: obsolete keys ignored in \"progress\" (you can delete them from navori.config.json): {list}"
        ),
    }
}

/// `common.deprecatedConfigKeys`.
#[must_use]
pub fn deprecated_config_keys(lang: Lang, list: &str) -> String {
    match lang {
        Lang::Es => format!(
            "navori: perillas obsoletas sin efecto completo en runtime (puedes borrarlas del navori.config.json): {list}"
        ),
        Lang::En => format!(
            "navori: deprecated knobs without a complete runtime effect (you can delete them from navori.config.json): {list}"
        ),
    }
}

/// `engine.managedBlockEditedByHand`.
#[must_use]
pub const fn managed_block_edited_by_hand(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "bloque managed editado por el usuario; en bloques de CLAUDE.md/AGENTS.md resuelve con 'navori sync'; en archivos completos ajusta el destino a mano o muévelo aparte y corre 'navori render --apply'"
        }
        Lang::En => {
            "managed block edited by hand; for CLAUDE.md/AGENTS.md blocks resolve with 'navori sync'; for whole files adjust the destination manually or move it aside and run 'navori render --apply'"
        }
    }
}

/// `engine.managedFileEditedResolvable`.
#[must_use]
pub const fn managed_file_edited_resolvable(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "bloque managed editado por el usuario; resuélvelo con 'navori sync --interactive' (o 'navori sync --accept-new-files --apply' para aceptar la versión renderizada)"
        }
        Lang::En => {
            "managed block edited by hand; resolve it with 'navori sync --interactive' (or 'navori sync --accept-new-files --apply' to accept the rendered version)"
        }
    }
}

/// `engine.markerlessFileEditedResolvable`.
#[must_use]
pub const fn markerless_file_edited_resolvable(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "archivo sin marcador de navori (editado por el usuario o ajeno); solo 'navori sync --interactive' puede reemplazarlo completo (con backup); ningún flag masivo lo toca. Si solo conserva parte del marcador o lo menciona en un comentario, muévelo aparte y corre 'navori render --apply'"
        }
        Lang::En => {
            "file without a navori marker (edited by hand or not navori's); only 'navori sync --interactive' can replace it whole (with a backup); no bulk flag touches it. If it keeps only part of the marker or mentions it in a comment, move it aside and run 'navori render --apply'"
        }
    }
}

/// `engine.subBlockEditedByHand`.
#[must_use]
pub fn sub_block_edited_by_hand(lang: Lang, id: &str, plugin: &str) -> String {
    match lang {
        Lang::Es => format!(
            "sub-bloque '{id}' (de @navori/plugin-{plugin}) editado por el usuario; ajusta el destino a mano"
        ),
        Lang::En => format!(
            "sub-block '{id}' (from @navori/plugin-{plugin}) edited by hand; adjust the destination manually"
        ),
    }
}

/// `engine.subBlockFromNewerNavori`.
#[must_use]
pub fn sub_block_from_newer_navori(lang: Lang, id: &str, version: Option<&str>) -> String {
    let version = version.unwrap_or("?");
    match lang {
        Lang::Es => format!(
            "sub-bloque '{id}' escrito por una navori m\u{e1}s nueva ({version}); no lo toqu\u{e9}. Actualiza tu CLI"
        ),
        Lang::En => format!(
            "sub-block '{id}' written by a newer navori ({version}); left untouched. Update your CLI"
        ),
    }
}

/// `engine.pluginSkillNotInjected`.
#[must_use]
pub fn plugin_skill_not_injected(lang: Lang, id: &str, plugin: &str, target: &str) -> String {
    match lang {
        Lang::Es => format!(
            "skill '{id}' (de @navori/plugin-{plugin}) no inyectado: target {target} ausente (\u{bf}agente disabled en config.harness?)"
        ),
        Lang::En => format!(
            "skill '{id}' (from @navori/plugin-{plugin}) not injected: target {target} missing (agent disabled in config.harness?)"
        ),
    }
}

/// `engine.claudeResidualPluginHook`.
#[must_use]
pub fn claude_residual_plugin_hook(lang: Lang, path: &str) -> String {
    match lang {
        Lang::Es => format!(
            "ALERTA: {path} puede seguir registrado en .claude/settings.json, que no se pudo actualizar; el hook puede seguir activo y no es confiable. Revisa ambos archivos manualmente."
        ),
        Lang::En => format!(
            "WARNING: {path} may remain registered in .claude/settings.json, which could not be updated; the hook may remain active and is untrusted. Review both files manually."
        ),
    }
}

/// `render.gitignoreHeader`.
#[must_use]
pub const fn gitignore_header(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "# .gitignore gestionado por navori. El bloque de abajo se regenera con 'navori render';\n# edita fuera de \u{e9}l con libertad.\n"
        }
        Lang::En => {
            "# .gitignore managed by navori. The block below is regenerated by 'navori render';\n# edit freely outside it.\n"
        }
    }
}

/// `engine.blockFromNewerNavori`.
#[must_use]
pub fn block_from_newer_navori(lang: Lang, version: Option<&str>) -> String {
    let version = version.unwrap_or("?");
    match lang {
        Lang::Es => format!(
            "bloque escrito por una navori más nueva ({version}); no lo toqué. Actualiza tu CLI: npm i -g navori@latest"
        ),
        Lang::En => format!(
            "block written by a newer navori ({version}); left untouched. Update your CLI: npm i -g navori@latest"
        ),
    }
}

/// `engine.managedBlocksOutOfOrder`.
#[must_use]
pub const fn managed_blocks_out_of_order(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "CLAUDE.md: los bloques managed están fuera del orden canónico, pero hay texto tuyo intercalado entre bloques, así que no los reordené. Mueve ese texto arriba del primer bloque managed o abajo del último para que navori pueda ordenarlos."
        }
        Lang::En => {
            "CLAUDE.md: the managed blocks are out of canonical order, but there's text of yours interleaved between blocks, so I didn't reorder them. Move that text above the first managed block or below the last one so navori can order them."
        }
    }
}

/// `blocks.agentsIndex`: `(heading, intro)`.
#[must_use]
pub const fn agents_index(lang: Lang) -> (&'static str, &'static str) {
    match lang {
        Lang::Es => (
            "## Agentes disponibles",
            "Subagentes que puedes lanzar con la herramienta `Agent` (tú eres el orquestador; ve \"## Role: orchestrator\"). La investigación y la revisión son de solo lectura → paraleliza sin miedo.",
        ),
        Lang::En => (
            "## Available agents",
            "Subagents you can spawn via the `Agent` tool (you are the orchestrator; see \"## Role: orchestrator\"). Research and review are read-only → parallelize them freely.",
        ),
    }
}

/// `blocks.agentsIndex.when[id]`.
#[must_use]
pub fn agent_when(lang: Lang, id: &str) -> Option<&'static str> {
    let es = lang == Lang::Es;
    Some(match id {
        "implementer" if es => {
            "Escribe código y tests para UNA tarea bien acotada. Úsalo proactivamente cuando el cambio toque 4+ archivos o 2+ no triviales."
        }
        "implementer" => {
            "Writes code and tests for ONE well-scoped task. Use proactively when a change touches 4+ files or 2+ non-trivial ones."
        }
        "reviewer" if es => {
            "Valida un diff (APPROVED / CHANGES_REQUESTED). Úsalo tras cada implementer y antes de cualquier commit, push o PR con código."
        }
        "reviewer" => {
            "Validates a diff (APPROVED / CHANGES_REQUESTED). Use after every implementer run and before any commit, push or PR."
        }
        "scout" if es => {
            "Reconocimiento de solo lectura: mapea un área o responde una pregunta acotada, con evidencia citada. Úsalo cuando una sub-pregunta convenga correr en paralelo, o una lectura convenga aislar del contexto de quien coordina."
        }
        "scout" => {
            "Read-only reconnaissance: maps an area or answers a scoped question, with cited evidence. Use when a sub-question is worth running in parallel, or a read is worth isolating from the coordinator context."
        }
        "auditor" if es => {
            "Auditoría de solo lectura con veredicto: área (seguridad, rendimiento, SOLID), ticket complejo o challenge de una propuesta, sin veredicto en el challenge. Úsalo cuando toque auditar un área o un ticket crítico, o antes de refactorizar sin ticket."
        }
        "auditor" => {
            "Read-only audit with a verdict: an area (security, performance, SOLID), a complex ticket, or a challenge of a proposed solution, no verdict on a challenge. Use when auditing an area or a critical ticket, or before refactoring one with no ticket."
        }
        "publisher" if es => {
            "Escribe commits Conventional y abre el PR. Úsalo tras la aprobación del reviewer."
        }
        "publisher" => {
            "Writes Conventional commits and opens the PR. Use after the reviewer approves."
        }
        "scribe" if es => {
            "Serializa evidencia estructurada en artefactos Markdown de handoff. Úsalo después de que un productor termine y antes de que su consumidor lea el artefacto."
        }
        "scribe" => {
            "Serializes structured evidence into Markdown handoff artifacts. Use after a producer completes and before its consumer reads the artifact."
        }
        "architect" if es => {
            "Propone qué construir y por qué, aplicando `solution-design`; no emite veredicto ni descompone. Úsalo cuando se dispare la fila arquitectónica, antes de descomponer en tareas."
        }
        "architect" => {
            "Proposes what to build and why, applying `solution-design`; issues no verdict and doesn't decompose. Use when the architectural row fires, before decomposing into tasks."
        }
        _ => return None,
    })
}

/// `tc(lang).blocks.projectContext`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectContext(pub Lang);

impl ProjectContext {
    fn es(self) -> bool {
        self.0 == Lang::Es
    }

    /// `heading`.
    #[must_use]
    pub fn heading(self) -> &'static str {
        if self.es() {
            "## Contexto del proyecto"
        } else {
            "## Project context"
        }
    }

    /// `intro`.
    #[must_use]
    pub fn intro(self) -> &'static str {
        if self.es() {
            "Reglas activas derivadas de tu config (`project.*`). Aplican a todos los agentes."
        } else {
            "Active rules derived from your config (`project.*`). They apply to all agents."
        }
    }

    /// `stageGreenfield`, `stageProduction` or `stageMigration`.
    #[must_use]
    pub fn stage(self, posture: &str) -> Option<&'static str> {
        let es = self.es();
        Some(match posture {
            "greenfield" if es => {
                "- **Etapa:** greenfield — favorece velocidad y menos ceremonia, pero el quality gate igual debe pasar."
            }
            "greenfield" => {
                "- **Stage:** greenfield — favor speed and less ceremony, but the quality gate must still pass."
            }
            "production" if es => {
                "- **Etapa:** en producción — favorece NO romper con regresiones. Los cambios de alto radio de impacto necesitan validación humana antes de mergear."
            }
            "production" => {
                "- **Stage:** in production — favor NOT breaking regressions. High-blast-radius changes need human validation before merging."
            }
            "migration" if es => {
                "- **Etapa:** migración legacy — cuida la compatibilidad legacy↔nuevo. El reviewer marca CRITICAL cuando un cambio lee de un lado y escribe en el otro."
            }
            "migration" => {
                "- **Stage:** legacy migration — watch legacy↔new compatibility. The reviewer flags CRITICAL when a change reads from one side and writes to the other."
            }
            _ => return None,
        })
    }

    /// `migrationRow`.
    #[must_use]
    pub fn migration_row(self, domain: &str, preferred: &str, legacy: &str) -> String {
        if self.es() {
            format!(
                "- **{domain} (migración):** en código nuevo usa `{preferred}`. `{legacy}` es legacy — no lo agregues; si tocas un módulo que lo usa, migra ese módulo completo (no mezcles ambos en el mismo archivo). El reviewer marca HIGH cualquier uso nuevo de `{legacy}`."
            )
        } else {
            format!(
                "- **{domain} (migration):** in new code use `{preferred}`. `{legacy}` is legacy — don't add it; if you touch a module that uses it, migrate that whole module (don't mix both in the same file). The reviewer flags HIGH any new use of `{legacy}`."
            )
        }
    }

    /// `rigorStrict` or `rigorPragmatic`.
    #[must_use]
    pub fn rigor(self, rigor: &str) -> Option<&'static str> {
        let es = self.es();
        Some(match rigor {
            "strict" if es => {
                "- **Rigor de revisión:** estricto — el reviewer bloquea APPROVED también con issues de confianza 65-79, no solo ≥80."
            }
            "strict" => {
                "- **Review rigor:** strict — the reviewer blocks APPROVED on confidence 65-79 issues too, not only ≥80."
            }
            "pragmatic" if es => {
                "- **Rigor de revisión:** pragmático — el reviewer bloquea solo issues ≥80; el resto queda como nota informativa."
            }
            "pragmatic" => {
                "- **Review rigor:** pragmatic — the reviewer blocks only ≥80 issues; the rest stays as an informative note."
            }
            _ => return None,
        })
    }

    /// `architecture`.
    #[must_use]
    pub fn architecture(self, rule: &str) -> String {
        if self.es() {
            format!(
                "- **Arquitectura:** el código nuevo DEBE seguir `{rule}`. El reviewer marca las desviaciones como HIGH."
            )
        } else {
            format!(
                "- **Architecture:** new code MUST follow `{rule}`. The reviewer flags deviations as HIGH."
            )
        }
    }

    /// `criticalAreas`.
    #[must_use]
    pub fn critical_areas(self, list: &str) -> String {
        if self.es() {
            format!("- **Áreas críticas** (revisión extra, severidad +1): {list}.")
        } else {
            format!("- **Critical areas** (extra review, severity +1): {list}.")
        }
    }

    /// `testsAlways`, `testsWhenApplicable` or `testsNone`.
    #[must_use]
    pub fn tests(self, policy: &str) -> Option<&'static str> {
        let es = self.es();
        Some(match policy {
            "always" if es => {
                "- **Tests:** el código nuevo DEBE incluir tests. El reviewer bloquea APPROVED si faltan."
            }
            "always" => {
                "- **Tests:** new code MUST ship with tests. The reviewer blocks APPROVED if they're missing."
            }
            "when-applicable" if es => {
                "- **Tests:** exige tests para lógica no trivial; opcionales para código simple."
            }
            "when-applicable" => {
                "- **Tests:** require tests for non-trivial logic; optional for simple code."
            }
            "none" if es => "- **Tests:** el repo no exige tests para código nuevo.",
            "none" => "- **Tests:** the repo doesn't require tests for new code.",
            _ => return None,
        })
    }

    /// `testsExclude`.
    #[must_use]
    pub fn tests_exclude(self, list: &str) -> String {
        if self.es() {
            format!(
                "- **Suites fuera de esa regla:** {list}. Se mantienen a mano — un cambio de código no exige actualizarlas, y el reviewer no bloquea por ellas."
            )
        } else {
            format!(
                "- **Suites outside that rule:** {list}. They are maintained by hand — a code change does not require updating them, and the reviewer does not block on them."
            )
        }
    }
}
