---
name: nestjs-dtos-validation
description: Reglas para DTOs y validación en NestJS — class-validator, ValidationPipe, transform. Aplica al definir contratos HTTP de entrada/salida.
type: reference
---

# NestJS DTOs + Validation — convenciones del proyecto

## Cuándo usar este skill

Antes de definir o modificar el shape de cualquier endpoint HTTP. El DTO es el contrato entre el cliente y el service; sin validación a la entrada el service tiene que defenderse de cualquier shape — explota o entrega data corrupta.

## Reglas duras

1. **DTO por dirección + intención.** `Create<X>Dto`, `Update<X>Dto`, `<X>ResponseDto`. No reusar el mismo DTO para create y update (los campos opcionales/obligatorios cambian) ni para entrada y salida (la respuesta expone campos que el cliente no envía: `id`, `createdAt`).
2. **`ValidationPipe` global con `whitelist: true` + `forbidNonWhitelisted: true`.** Sin esto, propiedades extra del cliente pasan al service. Configuralo en `main.ts`:
   ```ts
   app.useGlobalPipes(new ValidationPipe({
     whitelist: true,
     forbidNonWhitelisted: true,
     transform: true,
   }));
   ```
3. **`@Type(() => X)` para nested objects + arrays.** Sin `class-transformer`, los objetos anidados llegan como plain objects (no instancias) y `class-validator` no los recursea.
4. **Response DTO con `class-transformer`.** Usá `@Exclude()` / `@Expose()` para no devolver campos sensibles (passwords, internal IDs). Aplica con `ClassSerializerInterceptor` global o por endpoint.
5. **Mensajes de error en el DTO, no en el controller.** Cada decorador acepta `{ message: "..." }`. El cliente recibe un array de errores específico por campo, no un 400 genérico.

## Patrón típico

```ts
// dto/create-user.dto.ts
import { IsEmail, IsString, MinLength, IsOptional } from "class-validator";
import { Type } from "class-transformer";

export class CreateUserDto {
  @IsEmail({}, { message: "Email inválido" })
  email!: string;

  @IsString()
  @MinLength(8, { message: "Password debe tener al menos 8 caracteres" })
  password!: string;

  @IsOptional()
  @Type(() => AddressDto)
  address?: AddressDto;
}

// dto/user-response.dto.ts
import { Exclude, Expose } from "class-transformer";

export class UserResponseDto {
  @Expose() id!: string;
  @Expose() email!: string;
  @Expose() createdAt!: Date;

  @Exclude() password!: string;        // nunca al cliente
  @Exclude() passwordResetToken?: string;
}
```

## Tabla rápida

| Necesito | Decorador / approach |
|---|---|
| Campo obligatorio | sin `@IsOptional` + `@IsXxx` |
| Campo opcional | `@IsOptional()` antes del validador |
| String con largo mínimo | `@IsString() @MinLength(N)` |
| Email | `@IsEmail()` |
| Number rango | `@IsInt() @Min(N) @Max(M)` |
| Enum | `@IsEnum(MyEnum)` |
| Array de objetos | `@IsArray() @ValidateNested({ each: true }) @Type(() => ItemDto)` |
| Object anidado | `@ValidateNested() @Type(() => ChildDto)` |
| Excluir campo de la response | `@Exclude()` + `ClassSerializerInterceptor` |
| Renombrar campo en JSON | `@Expose({ name: "foo_bar" })` |

## Antes de declarar el cambio "listo"

- `{{qualityGate.fast}}` en verde.
- Probá el endpoint con un payload válido y otro inválido — el error response debe ser específico por campo, no un 400 genérico.
- Si agregaste un campo nuevo al CreateDto: ¿lo agregaste también al UpdateDto (si aplica) y al ResponseDto (si lo devolvés)?
- Si tocaste un Response DTO: verificá que ningún campo sensible (`password`, tokens internos) llega al cliente. Test con un user creado y `console.log(response)` para inspección.
