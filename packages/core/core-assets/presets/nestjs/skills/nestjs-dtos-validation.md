---
name: nestjs-dtos-validation
description: Reglas para DTOs y validación en NestJS — class-validator, ValidationPipe, transform. Aplica al definir contratos HTTP de entrada/salida.
type: reference
---

# NestJS DTOs + Validation — convenciones del proyecto

## Cuándo usar este skill

Antes de definir o modificar el shape de cualquier endpoint HTTP. El DTO es el contrato de entrada; sin validación el service recibe cualquier shape y explota o corrompe data.

## Reglas duras

1. **DTO por dirección + intención.** `Create<X>Dto`, `Update<X>Dto`, `<X>ResponseDto`. No reuses el mismo DTO para create y update, ni para entrada y salida (la respuesta expone `id`/`createdAt` que el cliente no envía). El `Update` idiomático es `class UpdateXDto extends PartialType(CreateXDto) {}` (`@nestjs/mapped-types`): hereda los validadores como opcionales, sin copiar-pegar ni desincronizar.
2. **`ValidationPipe` global con `whitelist: true` + `forbidNonWhitelisted: true`.** Sin esto, propiedades extra del cliente pasan al service. Configúralo en `main.ts`:
   ```ts
   app.useGlobalPipes(new ValidationPipe({
     whitelist: true,
     forbidNonWhitelisted: true,
     transform: true,
   }));
   ```
3. **`@Type(() => X)` para nested objects + arrays.** Sin `class-transformer`, los objetos anidados llegan como plain objects (no instancias) y `class-validator` no los recursea.
4. **Response DTO con `class-transformer` — y ojo con plain objects.** `@Exclude()`/`@Expose()` + `ClassSerializerInterceptor` para no devolver campos sensibles. **Gotcha de seguridad:** el interceptor solo transforma si el handler devuelve una **instancia** de la clase; con un plain object (Mongoose `.lean()`, objeto literal) `@Exclude()` se ignora y el `password` **se filtra**. Devuelve `plainToInstance(UserResponseDto, obj, { excludeExtraneousValues: true })`.
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
| Campo obligatorio / opcional | `@IsXxx` / `@IsOptional()` antes del validador |
| String largo mínimo / Email | `@IsString() @MinLength(N)` / `@IsEmail()` |
| Number rango / Enum | `@IsInt() @Min(N) @Max(M)` / `@IsEnum(MyEnum)` |
| Array de objetos | `@IsArray() @ValidateNested({ each: true }) @Type(() => ItemDto)` |
| Object anidado | `@ValidateNested() @Type(() => ChildDto)` |
| Excluir / renombrar en response | `@Exclude()` + interceptor / `@Expose({ name })` |

## Antes de declarar el cambio "listo"

- `{{qualityGate.fast}}` en verde; probado con payload válido e inválido (error específico por campo, no 400 genérico).
- Campo nuevo en CreateDto → reflejado en UpdateDto (`PartialType` lo hace solo) y ResponseDto si se devuelve.
- Response DTO: ningún campo sensible llega al cliente **con la data real del service** — si viene de `.lean()`/plain object, confirma que pasa por `plainToInstance`, no solo que tiene `@Exclude()`.
