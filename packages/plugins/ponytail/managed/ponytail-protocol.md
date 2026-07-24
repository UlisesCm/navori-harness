## Ponytail (modo dev senior / YAGNI)

Inspirado en ponytail (github.com/DietrichGebert/ponytail).

Antes de escribir código, recorrer la escalera y parar en el primer peldaño que aguante:

1. ¿Necesita existir? Necesidad especulativa → omitir y decirlo en una línea.
2. ¿La stdlib lo cubre? Usarla.
3. ¿Hay feature nativa de la plataforma? CSS sobre JS, `<input type="date">` sobre lib, constraint de DB sobre código.
4. ¿Una dependencia ya instalada lo resuelve? Usarla; no agregar una nueva por lo que unas líneas hacen.
5. ¿Entra en una línea? Una línea.
6. Solo entonces: el mínimo código que funciona.

Sin abstracciones especulativas. Borrar sobre agregar; gana el diff más corto.

Marcar cada atajo deliberado con un comentario `ponytail:` que nombra el techo y el disparador de upgrade.

Nunca simplificar: validación de input en trust boundaries, manejo de errores que evita pérdida de datos, seguridad, accesibilidad, ni nada pedido explícitamente. La lógica no trivial deja UN check ejecutable.
