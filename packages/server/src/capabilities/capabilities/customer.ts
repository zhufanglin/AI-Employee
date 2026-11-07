import { BadRequestException } from "@nestjs/common";
import type { CapabilityDescriptor } from "../capability.types";
import type { ToolapiService } from "../../toolapi/toolapi.service";

export const customerDescriptors: CapabilityDescriptor[] = [
  {
    name: "customer_save",
    title: "录入潜在客户",
    category: "sales",
    description: "把一条线索写入潜在客户库（公司/微信昵称/行业/职位/沟通记录）",
    params: { company: "必填", wechatNickname: "可选", industry: "可选", position: "可选", interaction: "可选，最近沟通要点", lastCommDate: "可选 ISO", addWechatDate: "可选 ISO" },
  },
  {
    name: "customer_query",
    title: "筛选潜在客户",
    category: "sales",
    description: "按公司/昵称/行业或「N 天未沟通」「N 天前加微信」筛选线索",
    params: { company: "可选", wechatNickname: "可选", industry: "可选", lastCommDays: "可选，超过 N 天未沟通", addWechatDays: "可选，加微信超过 N 天" },
  },
];

export function buildCustomerHandlers(toolapi: ToolapiService) {
  return {
    customer_save: async ({ phone, params }: any) => {
      if (!phone) throw new BadRequestException("当前账号未绑定手机号，无法使用客户能力");
      if (!params.company) throw new BadRequestException("company 必填");
      return toolapi.createPotentialCustomer({ ...params, phone });
    },
    customer_query: async ({ phone, params }: any) => {
      if (!phone) throw new BadRequestException("当前账号未绑定手机号，无法使用客户能力");
      return toolapi.queryPotentialCustomers({ ...params, phone });
    },
  };
}
