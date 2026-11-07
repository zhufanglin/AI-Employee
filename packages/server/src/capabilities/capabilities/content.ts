import { BadRequestException } from "@nestjs/common";
import type { CapabilityDescriptor } from "../capability.types";
import type { ToolapiService } from "../../toolapi/toolapi.service";

/** 素材内容：与 toolapi 的 ContentCollection 同表，能力名对齐原版 agent-tool-box */
export const contentDescriptors: CapabilityDescriptor[] = [
  {
    name: "content_save",
    title: "保存一条素材内容",
    category: "content",
    description: "把一条可用素材（标题/链接/要点）写入内容库，供晨报与分发使用",
    params: { title: "必填", contentSummary: "必填，要点摘要", category: "可选，如 短视频/文章", link: "可选", mustUse: "可选，是否必用" },
  },
  {
    name: "content_query",
    title: "查询素材内容",
    category: "content",
    description: "按分类/必用/已用/运营类型筛选内容库",
    params: { category: "可选", mustUse: "可选 true/false", isUsed: "可选 true/false", operationType: "可选" },
  },
  {
    name: "distribution_save",
    title: "保存今日分发记录",
    category: "content",
    description: "记录今天的发布摘要（可带海报图），用于分发看板与复盘",
    params: { summaryContent: "必填，今日分发摘要", posterImage: "可选，海报图片 URL", distributedAt: "可选 ISO 时间，默认现在" },
  },
];

export function buildContentHandlers(toolapi: ToolapiService, prisma: any) {
  return {
    content_save: async ({ phone, params }: any) => {
      if (!phone) throw new BadRequestException("当前账号未绑定手机号，无法使用内容能力");
      if (!params.title || !params.contentSummary) throw new BadRequestException("title 与 contentSummary 必填");
      return toolapi.createContent({ ...params, phone });
    },
    content_query: async ({ phone, params }: any) => {
      if (!phone) throw new BadRequestException("当前账号未绑定手机号，无法使用内容能力");
      return toolapi.queryContent({ ...params, phone });
    },
    distribution_save: async ({ phone, params }: any) => {
      if (!phone) throw new BadRequestException("当前账号未绑定手机号，无法使用内容能力");
      if (!params.summaryContent) throw new BadRequestException("summaryContent 必填");
      return prisma.dailyDistribution.create({
        data: {
          phone,
          summaryContent: String(params.summaryContent),
          posterImage: params.posterImage ?? null,
          distributedAt: params.distributedAt ? new Date(params.distributedAt) : new Date(),
        },
      });
    },
  };
}
