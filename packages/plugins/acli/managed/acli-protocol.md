## Tickets de Jira (acli)

Para leer tickets de Jira usá **acli** (no el MCP de Atlassian).

- Ver un ticket: `acli jira workitem view <KEY>` (ej. `acli jira workitem view BNM-123`)
- Buscar tickets: `acli jira workitem search --jql "<JQL>"`
- Listar comentarios: `acli jira workitem comment list --key <KEY>`
- Listar transiciones: `acli jira workitem transition list --key <KEY>`

El MCP de Atlassian/Rovo queda como fallback si `acli` falla o no está disponible.
