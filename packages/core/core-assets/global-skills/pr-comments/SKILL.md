---
name: pr-comments
description: "Review, evaluate, fix, and reply to PR comments in Spanish (MX). Trigger: 'revisar comentarios del PR', 'responder comentarios', 'PR comments', or when the user wants to address reviewer feedback."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## When to Use

The user wants to process reviewer comments on a Pull Request: read them, judge if each is correct or if there's a better solution, apply fixes, and reply.

## Required Skills to Load First

Load these BEFORE doing any work:

- `comment-writer` — voice and tone for replies
- `ponytail:ponytail` — laziest correct fix for any code change
- `judgment-day` — when a comment is non-trivial and needs adversarial check before agreeing
- Language/framework skills relevant to the diff (e.g. `react-19`, `nextjs-15`, `typescript`, `django-drf`, `pytest`)

## Workflow

### 1. Fetch comments

```bash
gh pr view <PR> --json number,title,headRefName,baseRefName
gh api repos/{owner}/{repo}/pulls/<PR>/comments    # inline review comments
gh api repos/{owner}/{repo}/issues/<PR>/comments   # general comments
```

Group by file/line. Ignore resolved/outdated unless user says otherwise.

### 2. Triage each comment

For every comment decide one of:

- **AGREE** — reviewer is right, apply fix.
- **BETTER** — reviewer's intent is valid but there's a better solution. Apply the better one, explain why in the reply.
- **REJECT** — reviewer is wrong or it's a non-issue. Explain why with technical reasoning.
- **DISCUSS** — needs user input (ambiguous, product decision, out of scope).

Verify before agreeing. Read the code, don't trust the comment blindly. If non-trivial, run `judgment-day` on the proposed fix.

### 3. Apply fixes (ponytail mode)

Use the ponytail ladder: stdlib > native > existing dep > one line > minimum code. No speculative refactors. One commit per logical group of comments.

### 4. Draft replies

Per comment, draft a short reply in **Mexican Spanish (tú)**, neutral and professional. Match `comment-writer` rules:

- Lead with the action: "Listo", "Lo dejé así porque…", "No lo apliqué porque…"
- 1–3 frases. Sin relleno.
- Si rechazas, da la razón técnica con evidencia (link a línea, doc, o test).
- Si propones algo mejor, di qué cambiaste y por qué.

### 5. MANDATORY review gate

Before publishing ANYTHING:

1. Show the user a table:
   | Comentario | Veredicto | Fix aplicado | Respuesta propuesta |
2. Show the diff of the fixes.
3. STOP and ask: "¿Publico estos comentarios y commiteo los fixes, o ajustamos algo?"

Do NOT post comments, push commits, or resolve threads until the user approves.

### 6. Publish

After approval:

- Commit fixes (conventional commits, no AI attribution).
- Reply per comment: `gh api -X POST repos/{owner}/{repo}/pulls/<PR>/comments/<comment_id>/replies -f body='…'` for inline; `gh pr comment <PR> -b '…'` for general.
- Resolve threads only if the user said so.

## Reply Examples

AGREE:
> Listo, lo cambié a `useId` para evitar la colisión en SSR.

BETTER:
> Buen punto. En vez de memoizar, extraje el cálculo fuera del render — React Compiler ya cubre el resto. Más simple y sin dependencias.

REJECT:
> No lo aplico: ese branch ya está cubierto por el guard de la línea 42, agregarlo acá duplicaría la validación. Te dejo el test que lo prueba: `auth.spec.ts:88`.

## Anti-patterns

- Aceptar todos los comentarios sin verificar.
- Respuestas largas explicando lo obvio.
- Aplicar fixes y publicar sin pasar por el gate de revisión.
- Mezclar fixes de varios comentarios en un commit gigante sin razón.
- Usar voseo o slang rioplatense.
