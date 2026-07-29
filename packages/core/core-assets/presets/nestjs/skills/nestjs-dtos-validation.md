---
name: nestjs-dtos-validation
description: Use when defining or modifying input/output HTTP contracts in NestJS — rules for DTOs and validation: class-validator, ValidationPipe, transform.
type: reference
---

# NestJS DTOs + Validation — project conventions

## When to use this skill

Before defining or modifying the shape of any HTTP endpoint. The DTO is the input contract; without validation the service receives any shape and blows up or corrupts data.

## Hard rules

1. **One DTO per direction + intent.** `Create<X>Dto`, `Update<X>Dto`, `<X>ResponseDto`. Don't reuse the same DTO for create and update, nor for input and output (the response exposes `id`/`createdAt` that the client doesn't send). The idiomatic `Update` is `class UpdateXDto extends PartialType(CreateXDto) {}` (`@nestjs/mapped-types`): it inherits the validators as optional, without copy-paste or drift.
2. **Global `ValidationPipe` with `whitelist: true` + `forbidNonWhitelisted: true`.** Without this, extra client properties reach the service. Configure it in `main.ts`:
   ```ts
   app.useGlobalPipes(new ValidationPipe({
     whitelist: true,
     forbidNonWhitelisted: true,
     transform: true,
   }));
   ```
3. **`@Type(() => X)` for nested objects + arrays.** Without `class-transformer`, nested objects arrive as plain objects (not instances) and `class-validator` doesn't recurse into them.
4. **Response DTO with `class-transformer` — and watch out for plain objects.** `@Exclude()`/`@Expose()` + `ClassSerializerInterceptor` to avoid returning sensitive fields. **Security gotcha:** the interceptor only transforms if the handler returns an **instance** of the class; with a plain object (Mongoose `.lean()`, an object literal) `@Exclude()` is ignored and the `password` **leaks**. Return `plainToInstance(UserResponseDto, obj, { excludeExtraneousValues: true })`.
5. **Error messages in the DTO, not in the controller.** Each decorator accepts `{ message: "..." }`. The client receives a per-field, specific error array, not a generic 400.

## Typical pattern

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

  @Exclude() password!: string;        // never to the client
  @Exclude() passwordResetToken?: string;
}
```

## Quick table

| I need | Decorator / approach |
|---|---|
| Required / optional field | `@IsXxx` / `@IsOptional()` before the validator |
| Min-length string / Email | `@IsString() @MinLength(N)` / `@IsEmail()` |
| Number range / Enum | `@IsInt() @Min(N) @Max(M)` / `@IsEnum(MyEnum)` |
| Array of objects | `@IsArray() @ValidateNested({ each: true }) @Type(() => ItemDto)` |
| Nested object | `@ValidateNested() @Type(() => ChildDto)` |
| Exclude / rename in response | `@Exclude()` + interceptor / `@Expose({ name })` |

## Before calling the change "done"

- `{{qualityGate.fast}}` green; tested with valid and invalid payloads (specific per-field error, not a generic 400).
- New field in CreateDto → reflected in UpdateDto (`PartialType` does it automatically) and ResponseDto if returned.
- Response DTO: no sensitive field reaches the client **with the service's real data** — if it comes from `.lean()`/a plain object, confirm it goes through `plainToInstance`, not just that it has `@Exclude()`.
