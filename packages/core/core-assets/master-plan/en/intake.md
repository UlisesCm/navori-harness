# context/INTAKE.md template

A table with one row per `context/raw/` file (R10, R11):

| File | Method | Result |
|---|---|---|
| <file> | markitdown <x.y.z> | context/md/<file>.md |
| <file> | native reading | context/md/<file>.md |
| <file> | exported to PDF by the user | context/md/<file>.md |
| <file> | not converted | <cause> |

Every referenced `context/md/<file>.md` starts with:

> Source: context/raw/<file> · Method: <method>
