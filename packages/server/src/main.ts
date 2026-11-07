import "reflect-metadata";
import { ValidationPipe, Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { json, raw, static as serveStatic } from "express";
import { join } from "node:path";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { ensureEnv, env, envInt } from "./common/env";
import { denyWorkspaceStatic } from "./common/workspace-static-guard";

async function bootstrap() {
  ensureEnv();
  const app = await NestFactory.create(AppModule, { logger: ["log", "warn", "error"] });

  // 微信支付回调必须拿原始报文验签，先于全局 JSON 解析器注册
  app.use("/api/payments/wechat/notify", raw({ type: "*/*" }));
  // 管理端上传（T-14）：base64 JSON 可达 200MB
  app.use(json({ limit: "220mb" }));
  // 本地上传文件静态服务（复刻口径：OSS 未配置时本地落盘）
  app.use("/uploads", denyWorkspaceStatic, serveStatic(join(process.cwd(), "uploads"), { maxAge: "7d", fallthrough: true }));
  // 运营后台（T-29）：零构建静态 SPA，前端直连同源 /api/admin/*
  app.use("/admin", serveStatic(join(__dirname, "..", "public", "admin"), { maxAge: "0", fallthrough: true }));

  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  app.enableCors({
    origin: env("CORS_ORIGINS", "*").split(",").map((s) => s.trim()),
    credentials: true,
  });
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle("中科元晟 AI 员工 · 复刻版 API")
    .setVersion("0.1.0")
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("api/docs", app, document);

  const port = envInt("PORT", 3000);
  await app.listen(port);
  new Logger("Bootstrap").log("server listening on http://127.0.0.1:" + port + "  (docs: /api/docs)");
}

bootstrap();
