# Línea base de delegación — pre-0.8.6

> Congelada el 2026-09-12, inmediatamente después de publicar **v0.8.6**, con el
> instrumento **de esa fecha**. Sirve para una sola cosa: comparar contra ella
> cuando haya sesiones corridas bajo 0.8.6.

## Por qué existe este archivo

0.8.6 retira la escalera R1/R2 (#691) — la doctrina que licenciaba resolver los
cambios chicos inline. Es el cambio dirigido justo al problema que toda la
auditoría venía midiendo.

Y **ninguna de las sesiones medidas corrió sin ella**: las 40 van de 0.7.0 a
0.8.5, y el retiro no salió de `main` hasta hoy. Así que estos números no son un
diagnóstico del harness — son el **antes** de un experimento que todavía no
tiene después.

Se congela ahora por dos razones, y la segunda importa más:

1. Los datos se pueden re-derivar, pero la **intención** no. Un número elegido
   después de ver el resultado no prueba nada.
2. **El instrumento cambió mucho hoy** (#709, #731, #732, #734, #738, #740,
   #741, #742). Medir el "después" con un instrumento distinto del "antes"
   mezcla dos efectos y no permite separarlos. Esta línea base está tomada con
   el instrumento posterior a todos esos arreglos; la comparación tiene que
   usar ese mismo o uno que solo agregue señal.

## Alcance de lo medido

| | |
|---|---|
| Sesiones auditadas | **60** |
| Con >= 3 oportunidades (las que puntúan) | **40** |
| Versiones renderizadas durante ellas | **0.7.0 … 0.8.5** |
| Escalera R1/R2 presente | **100%** |
| Cobertura de auditoría en la máquina | **32.7%** (64 de 196 transcripts) |

La cobertura es la debilidad conocida: el parque corre `audit.mode: opt-in`, así
que solo se mide lo que alguien armó a mano. **Es una muestra de conveniencia,
no un censo**, y cualquier lectura tiene que decirlo.

## Los números

### Por disparador

| disparador | oportunidades | activadas | tasa |
|---|---:|---:|---:|
| `pr → review-diff/pilot` | 260 | 37 | **14%** |
| `reviewer` | 103 | 38 | 36% |
| `implementer` | 81 | 43 | 53% |
| `debug-error` | 36 | 0 | 0% |
| `loop-back-debug` | 15 | 0 | 0% |
| `verify-before-done` | 1 | 0 | 0% |
| **TOTAL** | **496** | **118** | **23%** |

### Distribución por sesión — el número que importa

| tasa de la sesión | sesiones |
|---|---:|
| **0%** | **27 (67.5%)** |
| 1–24% | 3 (7.5%) |
| 25–74% | 6 (15.0%) |
| 75–100% | 4 (10.0%) |

**Dos tercios de las sesiones no delegan nada.** El agregado del 23% esconde
eso: no describe a una sesión típica, describe la media de dos poblaciones.

### Skills

De 18 declaradas, **14 no se invocaron ni se heredaron** en todo el rango. Las
de *tarea* se invocan (`spec-bootstrap` en 6 sesiones, `artifact-design` en 2);
las de *norma* solo se abren como archivo (`structural-search` en 5,
`verify-before-done` en 4, `review-diff` en 4).

## Qué se predice, y qué contaría como fracaso

Escrito ANTES de ver un solo dato de 0.8.6.

**La predicción**: si el retiro de la escalera funciona, la **tasa base de
sesiones que no delegan nada baja del 67.5%**. Esa es la métrica primaria — no
el agregado del 23%, que se mueve con la mezcla de trabajo.

**Qué contaría como que NO funcionó**, y hay que decirlo ahora para no
racionalizarlo después:

- La tasa base se queda en el rango 60-75% con >= 20 sesiones nuevas que
  puntúen. Eso significaría que la doctrina no era el cuello de botella, y que
  la línea divisoria medida —lo que bloquea funciona, lo que sugiere falla—
  aplica también a esto: haría falta un mecanismo, no una instrucción.
- La tasa baja pero solo en las sesiones de un repo. Eso sería mezcla de
  trabajo, no efecto de la doctrina; hay que mirar la distribución por repo con
  su conteo de sesiones al lado (la lección de #705).

**Qué NO cuenta como evidencia**: que suba el agregado del 23%. Se mueve al
cambiar la proporción de PRs por sesión, y `pr → pilot` domina el denominador
con 260 de 496 oportunidades. Un release con muchos PRs lo mueve solo.

**Tamaño mínimo antes de concluir**: 20 sesiones con >= 3 oportunidades bajo
0.8.6. Con menos, la tasa base del 67.5% hace que casi cualquier patrón sea
compatible con el azar — exactamente el error que produjo el hallazgo falso de
"cuatro repos inertes" en #705.

## Cómo reproducir

```bash
ls ~/.navori/audits/*/session-*.log | sed 's|.*/session-||; s|\.log$||' | sort -u > sessions.txt
python3 scripts/mine-activation.py sessions.txt
```

Para el "después", filtrar a sesiones cuyo registro `start` declare
`navoriRendered >= 0.8.6`. El minero ya imprime el rango de versiones del
conjunto que analiza, así que un corte mal hecho se ve en esa línea.

## Lo que falta para que la comparación valga

**El parque en `audit.mode: always`.** Con `opt-in`, el "después" vuelve a ser
una muestra de conveniencia y se hace imposible distinguir un cambio de conducta
de un cambio en qué se decidió medir. Es un campo por repo:

```json
{ "audit": { "mode": "always" } }
```

Cuesta un archivo de log por sesión y cero forks cuando no está armado (el gate
del recorder es un `stat`). Sin eso, esta línea base no tiene contra qué
compararse honestamente.
