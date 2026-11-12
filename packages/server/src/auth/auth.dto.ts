import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsOptional, IsPhoneNumber, IsString, Length, MaxLength, MinLength, ValidateNested } from "class-validator";

export class SendSmsCodeDto {
  @IsPhoneNumber("CN")
  phone!: string;

  @IsOptional()
  @IsIn(["login", "register", "reset", "bind"])
  purpose?: string;
}

/** P45：合规同意载荷（客户端在用户勾选后带上） */
export class ConsentDto {
  /** 法律文本版本，例如 2026-11-12 */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  version?: string;

  /** 个人信息跨境传输的「单独同意」，必须显式 true */
  @IsOptional()
  @IsBoolean()
  crossBorder?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  source?: string;
}

export class SmsLoginDto {
  @IsPhoneNumber("CN")
  phone!: string;

  @IsString()
  @Length(4, 8)
  code!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ConsentDto)
  consent?: ConsentDto;
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

  @IsOptional()
  @ValidateNested()
  @Type(() => ConsentDto)
  consent?: ConsentDto;
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

  @IsOptional()
  @ValidateNested()
  @Type(() => ConsentDto)
  consent?: ConsentDto;
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
