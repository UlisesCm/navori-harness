# Plantilla de parts.json

Plantilla de `parts.json`: una parte por entrega, ids `P1`, `P2`… consecutivos. Cada criterio de aceptación usa un método (`test`, `comando` o `manual`) con su bloque de detalle; los ids `A1`, `A2`… son consecutivos dentro de cada parte. `reason` solo aplica a `descartada` o `diferida`.

```json
{
  "version": 1,
  "parts": [
    {
      "id": "P1",
      "title": "<título de la parte>",
      "objective": "<qué entrega esta parte>",
      "scope": [
        "<qué incluye>"
      ],
      "outOfScope": [
        "<qué queda fuera>"
      ],
      "dependsOn": [],
      "seedRequirements": [
        "<requisito semilla>"
      ],
      "acceptance": [
        {
          "id": "A1",
          "method": "test",
          "description": "<qué prueba el test>",
          "test": {
            "file": "<path/to/file.test.ts>",
            "case": "<nombre del caso>"
          }
        },
        {
          "id": "A2",
          "method": "comando",
          "description": "<qué demuestra el comando>",
          "command": {
            "run": "<command>",
            "expected": "exit 0, <salida esperada>"
          }
        },
        {
          "id": "A3",
          "method": "manual",
          "description": "<qué se verifica a mano>",
          "manual": {
            "check": "<qué se revisa>",
            "how": "<cómo se revisa>"
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
      "title": "<título de la parte>",
      "objective": "<qué entrega esta parte>",
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
          "description": "<qué prueba el test>",
          "test": {
            "file": "<path/to/file.test.ts>",
            "case": "<nombre del caso>"
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
