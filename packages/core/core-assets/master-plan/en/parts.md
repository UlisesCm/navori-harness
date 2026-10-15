# parts.json template

`parts.json` template: one part per delivery, consecutive ids `P1`, `P2`… Each acceptance criterion uses one method (`test`, `comando` or `manual`) with its detail block; ids `A1`, `A2`… are consecutive within each part. `reason` only applies to `descartada` or `diferida`.

```json
{
  "version": 1,
  "parts": [
    {
      "id": "P1",
      "title": "<part title>",
      "objective": "<what this part delivers>",
      "scope": [
        "<what is included>"
      ],
      "outOfScope": [
        "<what is excluded>"
      ],
      "dependsOn": [],
      "seedRequirements": [
        "<seed requirement>"
      ],
      "acceptance": [
        {
          "id": "A1",
          "method": "test",
          "description": "<what the test proves>",
          "test": {
            "file": "<path/to/file.test.ts>",
            "case": "<case name>"
          }
        },
        {
          "id": "A2",
          "method": "comando",
          "description": "<what the command shows>",
          "command": {
            "run": "<command>",
            "expected": "exit 0, <expected output>"
          }
        },
        {
          "id": "A3",
          "method": "manual",
          "description": "<what is checked by hand>",
          "manual": {
            "check": "<what is reviewed>",
            "how": "<how it is reviewed>"
          }
        }
      ],
      "inheritedFrom": null,
      "state": "pendiente",
      "reason": null,
      "spec": null,
      "issue": null
    },
    {
      "id": "P2",
      "title": "<part title>",
      "objective": "<what this part delivers>",
      "scope": [],
      "outOfScope": [],
      "dependsOn": [
        "P1"
      ],
      "seedRequirements": [],
      "acceptance": [
        {
          "id": "A1",
          "method": "test",
          "description": "<what the test proves>",
          "test": {
            "file": "<path/to/file.test.ts>",
            "case": "<case name>"
          }
        }
      ],
      "inheritedFrom": null,
      "state": "pendiente",
      "reason": null,
      "spec": null,
      "issue": null
    }
  ]
}
```
