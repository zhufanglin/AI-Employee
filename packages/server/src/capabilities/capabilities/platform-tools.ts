import { BadRequestException } from "@nestjs/common";
import type { CapabilityDescriptor, CapabilityHandler } from "../capability.types";

/**
 * 平台自动发布能力（P24）。
 *
 * 这三个工具的真正实现在打包后的桌面端主进程：api() 拦截 /capabilities/run，
 * name 命中 platform_publish / platform_status / platform_stats 时在本机执行
 * （用 Electron 内嵌浏览器打开抖音/小红书/视频号创作后台，复用用户真实登录态），不发网络请求。
 * 服务端这里只负责在能力目录里登记描述符，让模型知道有这个能力、参数长什么样；
 * 云执行器（生产 worker）调用会直接拿到下面那句中文提示，模型据此向用户说明需要打开客户端。
 *
 * 为什么不在服务端做：生产机在美国机房，IP 和登录态都会触发平台风控；
 * 发布必须发生在用户自己的电脑、自己的网络、自己的账号上。
 */
const LOCAL_ONLY = "平台发布需要在桌面端（本机）执行，请在客户端登录平台后再试";

export const descriptors: CapabilityDescriptor[] = [
  {
    name: "platform_publish",
    title: "平台发布（本机）",
    category: "platform",
    description:
      "在用户电脑上打开创作后台自动发布抖音/小红书/视频号内容（上传素材 → 填标题正文话题 → 点发布），需桌面端已登录对应平台；服务端与云端执行器无法执行，调用会返回中文提示",
    params: {
      platform: "必填，平台：douyin（抖音）| xiaohongshu（小红书）| shipinhao（视频号）",
      type: "必填，发布类型：video（视频）| image（图文）",
      title: "可选，标题（抖音 ≤30 字、小红书 ≤20 字、视频号 ≤16 字，超出自动截断）",
      content: "必填，正文，可含 #话题",
      tags: "可选，话题标签，逗号分隔或数组，不带 #（自动拼到正文尾部）",
      mediaPaths: "必填，本机绝对路径，多个用逗号分隔；视频 1 个 mp4，图文 1-9 张 jpg/png",
    },
  },
  {
    name: "platform_status",
    title: "平台登录状态（本机）",
    category: "platform",
    description: "检查本机桌面端里抖音/小红书/视频号的登录状态（逐个打开隐藏窗口读取登录态），用于发布前确认账号可用",
    params: {
      platform: "可选，留空查全部：douyin（抖音）| xiaohongshu（小红书）| shipinhao（视频号）",
    },
  },
  {
    name: "platform_stats",
    title: "平台数据（本机）",
    category: "platform",
    description: "读取本机已发布内容的播放/点赞等数据（创作后台页面读取）；当前版本仅登记能力，尚未实现",
    params: {
      platform: "必填，平台：douyin（抖音）| xiaohongshu（小红书）| shipinhao（视频号）",
    },
  },
];

export function buildPlatformHandlers(): Record<string, CapabilityHandler> {
  const localOnly: CapabilityHandler = async () => {
    throw new BadRequestException(LOCAL_ONLY);
  };
  return {
    platform_publish: localOnly,
    platform_status: localOnly,
    platform_stats: localOnly,
  };
}
