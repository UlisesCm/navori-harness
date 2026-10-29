//! `lib/master/markers.ts`: the prose literals `check` parses out of architect-written Markdown and
//! the labels `STATUS.md` and the `navori:master-parts` region are rendered with, by language.
//! `CLOSURE.md`'s labels are not here: nothing native renders it yet.

/// `MasterMarkers.status`.
#[derive(Debug, Clone, Copy)]
pub struct StatusLabels {
    pub stage: &'static str,
    pub phase: &'static str,
    pub active_part: &'static str,
    pub closable: &'static str,
    pub yes: &'static str,
    pub no: &'static str,
    pub none: &'static str,
    pub blockers: &'static str,
    pub evidence: &'static str,
    pub discrepancies: &'static str,
    pub verified: &'static str,
    pub unverified: &'static str,
    pub columns: [&'static str; 5],
}

/// `MasterMarkers.parts`.
#[derive(Debug, Clone, Copy)]
pub struct PartsLabels {
    pub objective: &'static str,
    pub scope: &'static str,
    pub out_of_scope: &'static str,
    pub depends_on: &'static str,
    pub seed_requirements: &'static str,
    pub state: &'static str,
}

/// `MasterMarkers`.
#[derive(Debug, Clone, Copy)]
pub struct Markers {
    pub origen: &'static str,
    pub ninguna: &'static str,
    pub supuesto: &'static str,
    pub sin_verificar: &'static str,
    pub pregunta: &'static str,
    pub elegida: &'static str,
    pub descartadas: &'static str,
    pub fecha: &'static str,
    pub sin_decisiones: &'static str,
    pub no_aplica: &'static str,
    pub consultado: &'static str,
    pub archivo_column: &'static str,
    pub metodo_column: &'static str,
    pub resultado_column: &'static str,
    pub metodo_label: &'static str,
    pub ninguno_digest: &'static str,
    pub integridad: &'static str,
    pub codebase_headers: [&'static str; 4],
    pub status: StatusLabels,
    pub parts: PartsLabels,
}

const ES: Markers = Markers {
    origen: "Origen:",
    ninguna: "Ninguna",
    supuesto: "[SUPUESTO]",
    sin_verificar: "[SIN VERIFICAR]",
    pregunta: "Pregunta:",
    elegida: "Elegida:",
    descartadas: "Descartadas:",
    fecha: "Fecha:",
    sin_decisiones: "Sin decisiones",
    no_aplica: "No aplica:",
    consultado: "consultado",
    archivo_column: "Archivo",
    metodo_column: "Método",
    resultado_column: "Resultado",
    metodo_label: "Método",
    ninguno_digest: "Ninguno",
    integridad: "Integridad",
    codebase_headers: ["Stack", "Estructura", "Convenciones", "Specs"],
    status: StatusLabels {
        stage: "Estado de etapa",
        phase: "Fase",
        active_part: "Parte activa",
        closable: "Cerrable",
        yes: "sí",
        no: "no",
        none: "ninguna",
        blockers: "Bloqueos",
        evidence: "Evidencia",
        discrepancies: "Discrepancias",
        verified: "verificado",
        unverified: "sin evidencia",
        columns: ["Parte", "Estado", "Tareas", "Spec", "Issue"],
    },
    parts: PartsLabels {
        objective: "Objetivo",
        scope: "Alcance",
        out_of_scope: "Fuera de alcance",
        depends_on: "Dependencias",
        seed_requirements: "Requisitos semilla",
        state: "Estado",
    },
};

const EN: Markers = Markers {
    origen: "Source:",
    ninguna: "None",
    supuesto: "[ASSUMED]",
    sin_verificar: "[UNVERIFIED]",
    pregunta: "Question:",
    elegida: "Chosen:",
    descartadas: "Discarded:",
    fecha: "Date:",
    sin_decisiones: "No decisions",
    no_aplica: "Not applicable:",
    consultado: "consulted",
    archivo_column: "File",
    metodo_column: "Method",
    resultado_column: "Result",
    metodo_label: "Method",
    ninguno_digest: "None",
    integridad: "Integrity",
    codebase_headers: ["Stack", "Structure", "Conventions", "Specs"],
    status: StatusLabels {
        stage: "Stage status",
        phase: "Phase",
        active_part: "Active part",
        closable: "Closable",
        yes: "yes",
        no: "no",
        none: "none",
        blockers: "Blockers",
        evidence: "Evidence",
        discrepancies: "Discrepancies",
        verified: "verified",
        unverified: "no evidence",
        columns: ["Part", "State", "Tasks", "Spec", "Issue"],
    },
    parts: PartsLabels {
        objective: "Objective",
        scope: "Scope",
        out_of_scope: "Out of scope",
        depends_on: "Dependencies",
        seed_requirements: "Seed requirements",
        state: "State",
    },
};

/// `masterMarkers(language)`.
#[must_use]
pub const fn master_markers(english: bool) -> &'static Markers {
    if english { &EN } else { &ES }
}
