import { BadRequestException, Injectable } from "@nestjs/common";
import { deleteWorkspaceFile, displayName, listWorkspaceFiles, publicBase, resolveWorkspaceFile, saveWorkspaceFile } from "../capabilities/capabilities/files";

/**
 * 用户资料工作区：用户把表格/PDF/Word/文本上传进来，员工在任务里用 file_list / doc_read 读取。
 * 落盘位置与员工 file_write 同一个目录（uploads/workspace/<userId>/），OSS 配置齐全时同时上传。
 */
@Injectable()
export class WorkspaceService {
  async upload(user: any, body: any) {
    const userId = String(user?.id ?? "");
    if (!userId) throw new BadRequestException("缺少用户信息");
    const name = String(body?.name ?? body?.fileName ?? "").trim();
    const raw = String(body?.base64 ?? body?.content ?? body?.dataUrl ?? "").trim();
    if (!raw) throw new BadRequestException("base64 必填");
    const base64 = raw.includes(",") && /^data:/.test(raw) ? raw.slice(raw.indexOf(",") + 1) : raw;
    const buffer = Buffer.from(base64, "base64");
    if (!buffer.byteLength) throw new BadRequestException("文件内容为空");
    const saved = await saveWorkspaceFile(userId, name, buffer);
    return {
      name: saved.file.name,
      key: saved.file.key,
      ext: saved.file.ext,
      bytes: saved.file.bytes,
      url: saved.url,
      updatedAt: saved.file.updatedAt,
    };
  }

  async list(user: any, limitRaw?: any) {
    const userId = String(user?.id ?? "");
    const limit = Math.min(Math.max(Math.trunc(Number(limitRaw) || 50), 1), 200);
    const rows = await listWorkspaceFiles(userId);
    const base = publicBase();
    return {
      total: rows.length,
      items: rows.slice(0, limit).map(row => ({
        name: row.name,
        key: row.key,
        ext: row.ext,
        bytes: row.bytes,
        updatedAt: row.updatedAt,
        url: base ? base + "/uploads/" + row.key : null,
      })),
    };
  }

  async remove(user: any, body: any) {
    const userId = String(user?.id ?? "");
    const key = String(body?.key ?? "").trim();
    const name = String(body?.name ?? "").trim();
    if (!key && !name) throw new BadRequestException("key 或 name 至少填一个");
    const file = await resolveWorkspaceFile(userId, { key, name });
    if (!file) throw new BadRequestException("文件不存在或已被清理");
    await deleteWorkspaceFile(userId, { key: file.key });
    return { key: file.key, name: displayName(file.stored), deleted: true };
  }
}
