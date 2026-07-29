## Jira tickets (acli)

To read Jira tickets use **acli** (not the Atlassian MCP).

- View a ticket: `acli jira workitem view <KEY>` (e.g. `acli jira workitem view BNM-123`)
- Search tickets: `acli jira workitem search --jql "<JQL>"`
- List comments: `acli jira workitem comment list --key <KEY>`
- List transitions: `acli jira workitem transition list --key <KEY>`

The Atlassian/Rovo MCP remains the fallback if `acli` fails or is unavailable.
