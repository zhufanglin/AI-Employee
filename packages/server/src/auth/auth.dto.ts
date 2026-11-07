import { IsIn, IsOptional, IsPhoneNumber, IsString, Length, MaxLength, MinLength } from "class-validator";

export class SendSmsCodeDto {
  @IsPhoneNumber("CN")
  phone!: string;

  @IsOptional()
  @IsIn(["login", "register", "reset", "bind"])
  purpose?: string;
}

export class SmsLoginDto {
  @IsPhoneNumber("CN")
  phone!: string;

  @IsString()
  @Length(4, 8)
  code!: string;
}

export class PasswordLoginDto {
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  account!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(64)
  password!: string;
}

export class RegisterDto {
  @IsOptional()
  @IsPhoneNumber("CN")
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  email?: string;

  @IsString()
  @MinLength(6)
  @MaxLength(64)
  password!: string;

  @IsOptional()
  @IsString()
  @Length(4, 8)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;
}

export class AdminLoginDto {
  @IsString()
  username!: string;

  @IsString()
  password!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  oldPassword!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(64)
  newPassword!: string;
}
